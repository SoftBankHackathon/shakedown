import { setTimeout as sleep } from 'node:timers/promises';
import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ECSClient, CreateServiceCommand, UpdateServiceCommand, DeleteServiceCommand, DescribeServicesCommand, RegisterTaskDefinitionCommand, ListTasksCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client, ModifyListenerCommand, ModifyRuleCommand, ModifyTargetGroupCommand, ModifyTargetGroupAttributesCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ECRClient, DescribeImagesCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { HttpsControl } from './https-control.js';
import type { Config } from './config.js';
import { validateRequest } from './config.js';
import type { DeployRequest, Provider, ReadyResult, Log, LogLine } from './model.js';

async function phase<T>(name: string, log: Log, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log(`phase=${name} started`);
  try {
    const result = await work();
    log(`phase=${name} completed duration_ms=${Date.now() - started}`);
    return result;
  } catch (error) {
    log(`phase=${name} failed duration_ms=${Date.now() - started}`);
    throw error;
  }
}

export class AwsProvider implements Provider {
  ecs: ECSClient; elb: ElasticLoadBalancingV2Client; ecr: ECRClient; logs: CloudWatchLogsClient; sts: STSClient;
  constructor(public config: Config) {
    const options = { region: config.region, credentials: fromIni({ profile: config.profile }), maxAttempts: 2, requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 } };
    this.ecs = new ECSClient(options); this.elb = new ElasticLoadBalancingV2Client(options);
    this.ecr = new ECRClient(options); this.logs = new CloudWatchLogsClient(options); this.sts = new STSClient(options);
  }
  private httpsUrl?:string;
  private httpsGate(open:boolean,signal:AbortSignal){
    return new HttpsControl(this.config.httpsControlUrl,this.config.projectId).gate(open,signal);
  }
  private async route(open:boolean,signal:AbortSignal){
    const actions:any[]=open?[{Type:'forward',TargetGroupArn:this.config.targetGroupArn}]:[{Type:'fixed-response',FixedResponseConfig:{StatusCode:'403',ContentType:'text/plain',MessageBody:'Shakedown: deployment unavailable'}}];
    if(this.config.gateRuleArn)await this.elb.send(new ModifyRuleCommand({RuleArn:this.config.gateRuleArn,Actions:actions}),{abortSignal:signal});
    else await this.elb.send(new ModifyListenerCommand({ListenerArn:this.config.listenerArn,DefaultActions:actions}),{abortSignal:signal});
  }
  async verifyAccount() {
    const identity = await this.sts.send(new GetCallerIdentityCommand({}));
    if (identity.Account !== this.config.accountId) throw new Error('AWS 계정 ID가 설정과 다릅니다. 실행을 중단합니다.');
  }
  validate(request: DeployRequest) { validateRequest(this.config, request); }
  private network() { return { awsvpcConfiguration: { subnets: this.config.subnetIds, securityGroups: [this.config.securityGroupId], assignPublicIp: 'ENABLED' as const } }; }
  private async taskDefinition(request: DeployRequest, signal: AbortSignal, initialize = false) {
    const c = this.config;
    const image = await this.ecr.send(new DescribeImagesCommand({ repositoryName: c.repository, imageIds: [{ imageDigest: request.image.split('@')[1] }] }), { abortSignal: signal });
    const mediaType = image.imageDetails?.[0]?.imageManifestMediaType;
    if (!mediaType || mediaType.includes('index') || mediaType.includes('manifest.list')) throw new Error('A single Linux AMD64 image manifest is required; publish with --provenance=false --sbom=false');
    const result = await this.ecs.send(new RegisterTaskDefinitionCommand({
      family: c.serviceName, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '512', memory: '1024',
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: c.executionRoleArn, taskRoleArn: c.taskRoleArn,
      containerDefinitions: [{ name: 'app', image: request.image, essential: true,
        portMappings: [{ containerPort: c.port, protocol: 'tcp' }],
        environment: Object.entries({
          SPRING_DATASOURCE_URL: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}?sslmode=require`,
          SPRING_DATASOURCE_USERNAME: c.dbUsername,
          SPRING_JPA_HIBERNATE_DDL_AUTO: initialize ? 'update' : 'validate',
          SPRING_PROFILES_ACTIVE: initialize ? 'schema-init' : (request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory'),
          SERVER_PORT: String(c.port), TZ: request.options.tz,
        }).map(([name, value]) => ({ name, value })),
        secrets: [{ name: 'SPRING_DATASOURCE_PASSWORD', valueFrom: `${c.dbPasswordSecretArn}:password::` }],
        logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': c.logGroup, 'awslogs-region': c.region, 'awslogs-stream-prefix': request.deployment_id } },
      }],
    }), { abortSignal: signal });
    if (!result.taskDefinition?.taskDefinitionArn) throw new Error('ECS task definition ARN missing');
    return result.taskDefinition.taskDefinitionArn;
  }
  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    const c = this.config;
    await this.verifyAccount(); signal.throwIfAborted();
    await phase('close_route', log, () => this.closeRoute(signal));
    log('route closed: new deployment is preparing');
    const taskDefinition = await phase('register_task', log, () => this.taskDefinition(request, signal));
    log(`task definition registered: ${taskDefinition}`);
    await this.elb.send(new ModifyTargetGroupCommand({ TargetGroupArn: c.targetGroupArn, HealthCheckPath: request.health_path, Matcher: { HttpCode: '200' } }), { abortSignal: signal });
    await this.elb.send(new ModifyTargetGroupAttributesCommand({ TargetGroupArn: c.targetGroupArn, Attributes: [
      { Key: 'stickiness.enabled', Value: 'false' }, { Key: 'load_balancing.algorithm.type', Value: 'round_robin' }, { Key: 'deregistration_delay.timeout_seconds', Value: '5' },
    ] }), { abortSignal: signal });
    const current = await this.ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: [c.serviceName] }), { abortSignal: signal });
    const common = { cluster: c.clusterArn, taskDefinition, desiredCount: request.options.replicas, networkConfiguration: this.network(),
      deploymentConfiguration: { maximumPercent: 200, minimumHealthyPercent: 0, deploymentCircuitBreaker: { enable: true, rollback: false } }, healthCheckGracePeriodSeconds: 30 };
    if (current.services?.some(s => s.status === 'ACTIVE')) {
      await this.ecs.send(new UpdateServiceCommand({ ...common, service: c.serviceName, forceNewDeployment: true }), { abortSignal: signal });
    } else {
      await this.ecs.send(new CreateServiceCommand({ ...common, serviceName: c.serviceName, launchType: 'FARGATE', platformVersion: 'LATEST', clientToken: request.deployment_id,
        loadBalancers: [{ targetGroupArn: c.targetGroupArn, containerName: 'app', containerPort: c.port }],
      }), { abortSignal: signal });
    }
    log('ECS rollout started; waiting for new tasks and healthy targets');
    const actual = await phase('wait_healthy', log, () => this.waitReady(taskDefinition, request, signal));
    // Only expose after every registered target belongs to the new healthy revision.
    this.httpsUrl=await this.httpsGate(true,signal);
    if(!this.httpsUrl)await this.route(true,signal);
    await phase('public_health', log, () => this.waitHttp(request.health_path, 200, signal));
    log('public health check passed: HTTP 200 without cookies');
    return { url: this.httpsUrl??c.publicUrl, instances: actual.count, info: {
      runtime: 'ECS Fargate', database: 'RDS PostgreSQL 17', timezone: actual.tz,
      session: actual.profile.includes('session-jdbc') ? 'jdbc' : 'memory', sticky_sessions: 'false',
      image_digest: actual.digest, task_definition: taskDefinition, transport: this.httpsUrl?'HTTPS (edge)':'HTTP (demo)',
    } };
  }
  private async waitReady(taskDefinition: string, request: DeployRequest, signal: AbortSignal) {
    const c = this.config;
    while (true) {
      signal.throwIfAborted();
      const services = await this.ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: [c.serviceName] }), { abortSignal: signal });
      const service = services.services?.[0];
      if (service?.deployments?.some(d => d.taskDefinition === taskDefinition && d.rolloutState === 'FAILED')) throw new Error('ECS rollout failed; inspect task events');
      const listed = await this.ecs.send(new ListTasksCommand({ cluster: c.clusterArn, serviceName: c.serviceName, desiredStatus: 'RUNNING' }), { abortSignal: signal });
      if (listed.taskArns?.length) {
        const described = await this.ecs.send(new DescribeTasksCommand({ cluster: c.clusterArn, tasks: listed.taskArns }), { abortSignal: signal });
        const tasks = described.tasks ?? [];
        const targets = await this.elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: c.targetGroupArn }), { abortSignal: signal });
        const healthy = targets.TargetHealthDescriptions ?? [];
        const ips = new Set(tasks.flatMap(t => t.attachments?.flatMap(a => a.details?.filter(d => d.name === 'privateIPv4Address').map(d => d.value) ?? []) ?? []));
        if (tasks.length === request.options.replicas && !described.failures?.length && service?.pendingCount === 0 &&
          service.deployments?.length === 1 && service.deployments[0].taskDefinition === taskDefinition &&
          tasks.every(t => t.lastStatus === 'RUNNING' && t.taskDefinitionArn === taskDefinition && t.containers?.find(v => v.name === 'app')?.imageDigest === request.image.split('@')[1]) &&
          healthy.length === tasks.length && healthy.every(t => t.TargetHealth?.State === 'healthy' && ips.has(t.Target?.Id))) {
          const registered = await this.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition }), { abortSignal: signal });
          const env = Object.fromEntries(registered.taskDefinition?.containerDefinitions?.find(v => v.name === 'app')?.environment?.map(e => [e.name, e.value]) ?? []);
          return { count: tasks.length, digest: tasks[0].containers!.find(v => v.name === 'app')!.imageDigest!, tz: env.TZ ?? 'unknown', profile: env.SPRING_PROFILES_ACTIVE ?? 'unknown' };
        }
      }
      await sleep(2_000, undefined, { signal });
    }
  }
  private async closeRoute(signal: AbortSignal) {
    try{this.httpsUrl=await this.httpsGate(false,signal);}
    finally{await this.route(false,signal);}
    await this.waitHttp('/', 403, signal);
  }
  private async waitHttp(path: string, expected: number, signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();
      try {
        const response = await fetch(new URL(path, this.httpsUrl??this.config.publicUrl), { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), headers: { 'Cache-Control': 'no-cache' } });
        await response.body?.cancel();
        if (response.status === expected) return;
      } catch { signal.throwIfAborted(); }
      await sleep(1_000, undefined, { signal });
    }
  }
  async stop(log: Log) {
    const c = this.config, signal = AbortSignal.timeout(120_000);
    await this.verifyAccount();
    await this.closeRoute(signal);
    log('public route blocked: HTTP 403 confirmed');
    const result = await this.ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: [c.serviceName] }), { abortSignal: signal });
    const service = result.services?.[0];
    if (!service || service.status === 'INACTIVE') return;
    if (service.status === 'ACTIVE') {
      await this.ecs.send(new UpdateServiceCommand({ cluster: c.clusterArn, service: c.serviceName, desiredCount: 0 }), { abortSignal: signal });
      await this.ecs.send(new DeleteServiceCommand({ cluster: c.clusterArn, service: c.serviceName, force: true }), { abortSignal: signal });
    }
    while (true) {
      const status = await this.ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: [c.serviceName] }), { abortSignal: signal });
      const remaining = await this.ecs.send(new ListTasksCommand({ cluster: c.clusterArn, serviceName: c.serviceName, desiredStatus: 'RUNNING' }), { abortSignal: signal });
      if ((!status.services?.[0] || status.services[0].status === 'INACTIVE') && !remaining.taskArns?.length) break;
      await sleep(2_000, undefined, { signal });
    }
    log('ECS service stopped; RDS and CloudWatch logs retained');
  }
  async appLogs(id: string, since?: string): Promise<LogLine[]> {
    const signal = AbortSignal.timeout(15_000);
    const streams = await this.logs.send(new DescribeLogStreamsCommand({ logGroupName: this.config.logGroup, logStreamNamePrefix: `${id}/app/`, limit: 50 }), { abortSignal: signal });
    const lines = await Promise.all((streams.logStreams ?? []).map(async stream => {
      const result = await this.logs.send(new GetLogEventsCommand({ logGroupName: this.config.logGroup, logStreamName: stream.logStreamName!, startTime: since ? Date.parse(since) : undefined, startFromHead: false, limit: 50 }), { abortSignal: signal });
      return (result.events ?? []).map(e => ({ ts: new Date(e.timestamp ?? 0).toISOString(), source: 'app' as const, line: e.message ?? '' }));
    }));
    return lines.flat().sort((a, b) => a.ts.localeCompare(b.ts)).slice(-50);
  }

  async initialize(request: DeployRequest, log: Log) {
    await this.verifyAccount();
    const signal = AbortSignal.timeout(600_000);
    const definition = await this.taskDefinition(request, signal, true);
    const result = await this.ecs.send(new RunTaskCommand({ cluster: this.config.clusterArn, taskDefinition: definition, launchType: 'FARGATE', platformVersion: 'LATEST', count: 1, networkConfiguration: this.network() }), { abortSignal: signal });
    const task = result.tasks?.[0]?.taskArn;
    if (!task || result.failures?.length) throw new Error('DB initialization task could not start');
    log(`DB initialization task: ${task}`);
    try {
      while (true) {
        const state = await this.ecs.send(new DescribeTasksCommand({ cluster: this.config.clusterArn, tasks: [task] }), { abortSignal: signal });
        if (state.tasks?.[0]?.lastStatus === 'STOPPED') {
          if (state.tasks[0].containers?.find(c => c.name === 'app')?.exitCode !== 0) throw new Error('DB initialization failed; inspect its CloudWatch stream');
          log('DB schema initialization completed'); return;
        }
        await sleep(3_000, undefined, { signal });
      }
    } catch (error) {
      await this.ecs.send(new StopTaskCommand({ cluster: this.config.clusterArn, task, reason: 'Schema initialization interrupted' }));
      throw error;
    }
  }
}
