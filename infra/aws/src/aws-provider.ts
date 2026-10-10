import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { synchronizeDatabaseUrl } from './database-url.js';
import { databaseEnvironment, managedDatabase } from '../../../packages/contracts/runtime.mjs';
import { architectures } from './architecture.js';
import { RDSClient, DescribeDBInstancesCommand, ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import { EC2Client, DescribeSubnetsCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { ApplicationAutoScalingClient, RegisterScalableTargetCommand, DeregisterScalableTargetCommand, DescribeScalableTargetsCommand, PutScalingPolicyCommand } from '@aws-sdk/client-application-auto-scaling';
import { setTimeout as sleep } from 'node:timers/promises';
import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ECSClient, CreateServiceCommand, UpdateServiceCommand, DeleteServiceCommand, DescribeServicesCommand, RegisterTaskDefinitionCommand, ListTasksCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client, ModifyRuleCommand, ModifyTargetGroupCommand, ModifyTargetGroupAttributesCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
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
  secretManager: SecretsManagerClient;
  rds: RDSClient; ec2: EC2Client; scaling: ApplicationAutoScalingClient;
  ecs: ECSClient; elb: ElasticLoadBalancingV2Client; ecr: ECRClient; logs: CloudWatchLogsClient; sts: STSClient;
  constructor(public config: Config) {
    const options = { region: config.region, credentials: fromIni({ profile: config.profile }), maxAttempts: 2, requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 } };
    this.secretManager = new SecretsManagerClient(options);
    this.rds = new RDSClient(options); this.ec2 = new EC2Client(options); this.scaling = new ApplicationAutoScalingClient(options);
    this.ecs = new ECSClient(options); this.elb = new ElasticLoadBalancingV2Client(options);
    this.ecr = new ECRClient(options); this.logs = new CloudWatchLogsClient(options); this.sts = new STSClient(options);
  }
  private httpsUrl?:string;
  private httpsGate(open:boolean,signal:AbortSignal){
    return new HttpsControl(this.config.httpsControlUrl,this.config.projectId).gate(open,signal);
  }
  private async route(open:boolean,signal:AbortSignal){
    const actions:any[]=open?[{Type:'forward',TargetGroupArn:this.config.targetGroupArn}]:[{Type:'fixed-response',FixedResponseConfig:{StatusCode:'403',ContentType:'text/plain',MessageBody:'Shakedown: deployment unavailable'}}];
    await this.elb.send(new ModifyRuleCommand({RuleArn:this.config.gateRuleArn,Actions:actions}),{abortSignal:signal});
  }
  async verifyAccount() {
    const identity = await this.sts.send(new GetCallerIdentityCommand({}));
    if (identity.Account !== this.config.accountId) throw new Error('AWS 계정 ID가 설정과 다릅니다. 실행을 중단합니다.');
  }
  validate(request: DeployRequest) { validateRequest(this.config, request); }
  private network(request?: DeployRequest) { return { awsvpcConfiguration: { subnets: request?.architecture ? this.config.subnetIds.slice(0, architectures[request.architecture.template_id].azs) : this.config.subnetIds, securityGroups: [this.config.securityGroupId], assignPublicIp: 'ENABLED' as const } }; }
  private async taskDefinition(request: DeployRequest, signal: AbortSignal, initialize = false) {
    const c = this.config;
    const image = await this.ecr.send(new DescribeImagesCommand({ repositoryName: c.repository, imageIds: [{ imageDigest: request.image.split('@')[1] }] }), { abortSignal: signal });
    const mediaType = image.imageDetails?.[0]?.imageManifestMediaType;
    if (!mediaType || mediaType.includes('index') || mediaType.includes('manifest.list')) throw new Error('A single Linux AMD64 image manifest is required; publish with --provenance=false --sbom=false');
    const runtime=request.runtime;
    const urlSecrets = runtime && managedDatabase(runtime.database.mode) && Object.values(runtime.database.bindings).some(v=>['postgres_url','mysql_url','mongodb_url'].includes(v))
      ? await synchronizeDatabaseUrl(this.secretManager,c,signal) : undefined;
    const genericEnv=runtime ? {...runtime.env,PORT:String(runtime.port),TZ:request.options.tz,
      ...(managedDatabase(runtime.database.mode)?databaseEnvironment(runtime,{host:c.dbHost!,username:c.dbUsername!,ssl:c.dbEngine!=='mongodb'}):{})} : {};
    const genericSecrets=runtime ? [
      ...Object.entries(runtime.secret_refs).map(([name,ref])=>({name,valueFrom:c.secrets[ref]})),
      ...Object.entries(runtime.database.bindings).filter(([,v])=>v==='password').map(([name])=>({name,valueFrom:urlSecrets?.passwordReference ?? `${c.dbPasswordSecretArn}:password::`})),
      ...Object.entries(runtime.database.bindings).filter(([,v])=>['postgres_url','mysql_url','mongodb_url'].includes(v)).map(([name])=>({name,valueFrom:urlSecrets!.urlReference})),
    ] : [];
    const result = await this.ecs.send(new RegisterTaskDefinitionCommand({
      family: c.serviceName, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: request.architecture ? architectures[request.architecture.template_id].cpu : '512', memory: request.architecture ? architectures[request.architecture.template_id].memory : '1024',
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: c.executionRoleArn, taskRoleArn: c.taskRoleArn,
      ...(runtime?.database.mode==='mongodb'?{volumes:[{name:'database-ca'}]}:{}),
      containerDefinitions: [{ name: 'app', image: request.image, essential: true,
        portMappings: [{ containerPort: c.port, protocol: 'tcp' }],
        environment: Object.entries(runtime ? genericEnv : {
          SPRING_DATASOURCE_URL: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}?sslmode=require`,
          SPRING_DATASOURCE_USERNAME: c.dbUsername,
          SPRING_JPA_HIBERNATE_DDL_AUTO: initialize ? 'update' : 'validate',
          SPRING_PROFILES_ACTIVE: initialize ? 'schema-init' : (request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory'),
          SERVER_PORT: String(c.port), TZ: request.options.tz,
        }).map(([name, value]) => ({ name, value })),
        ...(runtime?.database.mode==='mongodb'?{mountPoints:[{sourceVolume:'database-ca',containerPath:'/run/shakedown/db-ca',readOnly:true}],dependsOn:[{containerName:'database-ca',condition:'SUCCESS' as const}]}:{}),
        secrets: runtime ? genericSecrets : [{ name: 'SPRING_DATASOURCE_PASSWORD', valueFrom: `${c.dbPasswordSecretArn}:password::` }],
        ...(initialize && runtime ? {entryPoint:[runtime.init_command[0]],command:runtime.init_command.slice(1)} : {}),
        logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': c.logGroup, 'awslogs-region': c.region, 'awslogs-stream-prefix': request.deployment_id } },
      },...(runtime?.database.mode==='mongodb'?[{name:'database-ca',image:'alpine:3.22',essential:false,entryPoint:['/bin/sh','-c'],command:['printf \'%s\' "$CA_PEM" > /certs/ca.pem && chmod 0444 /certs/ca.pem'],secrets:[{name:'CA_PEM',valueFrom:urlSecrets!.caReference!}],mountPoints:[{sourceVolume:'database-ca',containerPath:'/certs',readOnly:false}]}]:[])],
    }), { abortSignal: signal });
    if (!result.taskDefinition?.taskDefinitionArn) throw new Error('ECS task definition ARN missing');
    return result.taskDefinition.taskDefinitionArn;
  }
  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    const c = this.config;
    this.validate(request);
    await this.verifyAccount(); signal.throwIfAborted();
    if(request.runtime?.database.mode==='mongodb') await this.checkMongo(signal);
    if (request.architecture) await this.checkFoundation(request, signal);
    await phase('close_route', log, () => this.closeRoute(signal));
    log('route closed: new deployment is preparing');
    // Stop previous scaling before a rollout; never allow it to undo desiredCount.
    if (c.dbInstanceId || !c.dbHost) await this.removeScaling(signal);
    if (request.architecture && (!request.runtime || ['postgres','mysql'].includes(request.runtime.database.mode))) {
      await phase('database_architecture', log, () => this.configureDatabase(request, signal));
    }
    if (request.runtime ? request.runtime.init_command.length>0 : !!request.architecture) await phase('schema_init', log, () => this.initialize(request, log, signal));
    const taskDefinition = await phase('register_task', log, () => this.taskDefinition(request, signal));
    log(`task definition registered: ${taskDefinition}`);
    await this.elb.send(new ModifyTargetGroupCommand({ TargetGroupArn: c.targetGroupArn, HealthCheckPath: request.health_path, Matcher: { HttpCode: '200' } }), { abortSignal: signal });
    await this.elb.send(new ModifyTargetGroupAttributesCommand({ TargetGroupArn: c.targetGroupArn, Attributes: [
      { Key: 'stickiness.enabled', Value: 'false' }, { Key: 'load_balancing.algorithm.type', Value: 'round_robin' }, { Key: 'deregistration_delay.timeout_seconds', Value: '5' },
    ] }), { abortSignal: signal });
    const current = await this.ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: [c.serviceName] }), { abortSignal: signal });
    const common = { cluster: c.clusterArn, taskDefinition, desiredCount: request.options.replicas, networkConfiguration: this.network(request),
      deploymentConfiguration: { maximumPercent: 200, minimumHealthyPercent: 0, deploymentCircuitBreaker: { enable: true, rollback: false } }, healthCheckGracePeriodSeconds: 120 };
    if (current.services?.some(s => s.status === 'ACTIVE')) {
      await this.ecs.send(new UpdateServiceCommand({ ...common, service: c.serviceName, forceNewDeployment: true }), { abortSignal: signal });
    } else {
      await this.ecs.send(new CreateServiceCommand({ ...common, serviceName: c.serviceName, launchType: 'FARGATE', platformVersion: 'LATEST', clientToken: request.deployment_id,
        loadBalancers: [{ targetGroupArn: c.targetGroupArn, containerName: 'app', containerPort: c.port }],
      }), { abortSignal: signal });
    }
    log('ECS rollout started; waiting for new tasks and healthy targets');
    const actual = await phase('wait_healthy', log, () => this.waitReady(taskDefinition, request, signal));
    if (request.architecture) await phase('autoscaling', log, () => this.configureScaling(request, signal));
    // Only expose after every registered target belongs to the new healthy revision.
    this.httpsUrl=await this.httpsGate(true,signal);
    if(!this.httpsUrl)await this.route(true,signal);
    await phase('public_health', log, () => this.waitHttp(request.health_path, 200, signal));
    log('public health check passed: HTTP 200 without cookies');
    return { url: this.httpsUrl??c.publicUrl, instances: actual.count, info: {
      architecture: request.architecture?.template_id ?? 'legacy',
      runtime: 'ECS Fargate', database: request.runtime?.database.mode==='none'?'none':request.runtime?.database.mode==='external'?'external':(c.dbEngine==='mongodb'?'MongoDB TLS replica set (3 AZ)':`RDS ${c.dbEngine}`), timezone: actual.tz,
      session: request.runtime ? 'app-managed' : actual.profile.includes('session-jdbc') ? 'jdbc' : 'memory', sticky_sessions: 'false',
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
          if (request.architecture && new Set(tasks.map(t => t.availabilityZone).filter(Boolean)).size < architectures[request.architecture.template_id].azs) {
            await sleep(2_000, undefined, { signal }); continue;
          }
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
    // ECS service deletion can remain DRAINING after tasks stop; allow control-plane convergence.
    const c = this.config, signal = AbortSignal.timeout(600_000);
    await this.verifyAccount();
    await this.closeRoute(signal);
    log('public route blocked: HTTP 403 confirmed');
    if (c.dbInstanceId || !c.dbHost) await this.removeScaling(signal);
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
    log('ECS service stopped; database infrastructure and CloudWatch logs retained');
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

  private scalingResource() { return `service/${this.config.clusterArn.split('/').pop()}/${this.config.serviceName}`; }
  private async removeScaling(signal: AbortSignal) {
    const ResourceId = this.scalingResource();
    const state = await this.scaling.send(new DescribeScalableTargetsCommand({ ServiceNamespace: 'ecs', ResourceIds: [ResourceId], ScalableDimension: 'ecs:service:DesiredCount' }), { abortSignal: signal });
    if (state.ScalableTargets?.length) await this.scaling.send(new DeregisterScalableTargetCommand({ ServiceNamespace: 'ecs', ResourceId, ScalableDimension: 'ecs:service:DesiredCount' }), { abortSignal: signal });
  }
  private async checkMongo(signal:AbortSignal) {
    const result=await this.ec2.send(new DescribeInstancesCommand({InstanceIds:this.config.dbInstanceIds}),{abortSignal:signal});
    const instances=result.Reservations?.flatMap(r=>r.Instances??[])??[];
    const network=await this.ec2.send(new DescribeSubnetsCommand({SubnetIds:this.config.subnetIds}),{abortSignal:signal});
    if(instances.length!==3||instances.filter(i=>i.State?.Name==='running').length<2||instances.some(i=>!this.config.dbHosts?.includes(i.PrivateIpAddress??''))||new Set(instances.map(i=>i.Placement?.AvailabilityZone)).size!==3||network.Subnets?.length!==this.config.subnetIds.length||instances.some(i=>i.VpcId!==network.Subnets?.[0].VpcId))throw new Error('MongoDB replica set EC2 state/address/AZ/VPC does not match configuration');
  }

  private async checkFoundation(request: DeployRequest, signal: AbortSignal) {
    const spec = architectures[request.architecture!.template_id];
    const subnets = await this.ec2.send(new DescribeSubnetsCommand({ SubnetIds: this.config.subnetIds.slice(0, spec.azs) }), { abortSignal: signal });
    if (subnets.Subnets?.length !== spec.azs || new Set(subnets.Subnets.map(s => s.AvailabilityZone)).size !== spec.azs || new Set(subnets.Subnets.map(s => s.VpcId)).size !== 1) throw new Error('선택 구성의 AZ별 서브넷이 필요합니다. 기반 스택 설정을 갱신하세요.');
    if (request.runtime && !['postgres','mysql'].includes(request.runtime.database.mode)) return;
    const db = (await this.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: this.config.dbInstanceId }), { abortSignal: signal })).DBInstances?.[0];
    if (!db || db.Engine !== this.config.dbEngine || db.Endpoint?.Address !== this.config.dbHost || db.DBSubnetGroup?.VpcId !== subnets.Subnets[0].VpcId) throw new Error('준비된 DB 엔진/네트워크가 어댑터 설정과 일치하지 않습니다.');
  }
  private async configureDatabase(request: DeployRequest, signal: AbortSignal) {
    const multi = architectures[request.architecture!.template_id].multiAZ;
    // Wait out an existing modification before deciding whether another is needed.
    while (true) {
      signal.throwIfAborted();
      const db = (await this.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: this.config.dbInstanceId }), { abortSignal: signal })).DBInstances?.[0];
      if (!db) throw new Error('Configured RDS instance was not found');
      if (db.DBInstanceStatus === 'available' && Object.keys(db.PendingModifiedValues ?? {}).length === 0) {
        if (db.MultiAZ === multi) return;
        await this.rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: this.config.dbInstanceId, MultiAZ: multi, ApplyImmediately: true }), { abortSignal: signal });
      }
      await sleep(5_000, undefined, { signal });
    }
  }
  private async configureScaling(request: DeployRequest, signal: AbortSignal) {
    const spec = architectures[request.architecture!.template_id];
    if (spec.max === spec.min) return;
    const target = { ServiceNamespace: 'ecs' as const, ResourceId: this.scalingResource(), ScalableDimension: 'ecs:service:DesiredCount' as const };
    await this.scaling.send(new RegisterScalableTargetCommand({ ...target, MinCapacity: spec.min, MaxCapacity: spec.max }), { abortSignal: signal });
    await this.scaling.send(new PutScalingPolicyCommand({ ...target, PolicyName: 'shakedown-cpu', PolicyType: 'TargetTrackingScaling', TargetTrackingScalingPolicyConfiguration: { TargetValue: 60, PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' }, ScaleOutCooldown: 60, ScaleInCooldown: 300 } }), { abortSignal: signal });
  }

  async initialize(request: DeployRequest, log: Log, parentSignal?: AbortSignal) {
    this.validate(request);
    if (request.runtime && !request.runtime.init_command.length) return;
    await this.verifyAccount();
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
    const definition = await this.taskDefinition(request, signal, true);
    const result = await this.ecs.send(new RunTaskCommand({ cluster: this.config.clusterArn, taskDefinition: definition, launchType: 'FARGATE', platformVersion: 'LATEST', count: 1, networkConfiguration: this.network(request) }), { abortSignal: signal });
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
