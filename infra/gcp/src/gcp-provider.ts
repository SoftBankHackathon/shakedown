import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';
import { validateRequest } from './config.js';
import type { CloudRun, RunEnv, RunJob, RunService, RunVpcAccess } from './cloud-run.js';
import type { DeployRequest, ReadyResult, Log } from './model.js';

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

export class GcpProvider {
  constructor(public config: Config, private run: CloudRun, private fetchFn: typeof fetch = fetch) {}

  validate(request: DeployRequest) { validateRequest(this.config, request); }

  // 배포마다 리비전 이름을 정해 둔다. 그래야 로그를 그 배포의 리비전으로만 거를 수 있다(AWS가 배포 ID별 로그 스트림을 쓰는 것과 같은 효과).
  // Cloud Run 리비전 이름은 "서비스 이름-"으로 시작하고 63자 이하여야 한다. 배포 ID는 60자까지라 해시 12자리로 줄인다.
  private revisionName(deploymentId: string) {
    return `${this.config.serviceName}-${createHash('sha256').update(deploymentId).digest('hex').slice(0, 12)}`;
  }

  private profile(request: DeployRequest) { return request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory'; }

  private env(request: DeployRequest, initialize: boolean): RunEnv[] {
    const c = this.config;
    return [
      ...Object.entries({
        SPRING_DATASOURCE_URL: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}`,
        SPRING_DATASOURCE_USERNAME: c.dbUsername,
        // 테이블은 Job 한 곳에서만 고친다(update). 앱은 validate로 떠서 2대가 동시에 DDL을 돌리지 않게 한다.
        SPRING_JPA_HIBERNATE_DDL_AUTO: initialize ? 'update' : 'validate',
        SPRING_PROFILES_ACTIVE: initialize ? 'schema-init' : this.profile(request),
        TZ: request.options.tz,
      }).map(([name, value]) => ({ name, value })),
      // 비밀번호 값은 Cloud Run이 Secret Manager에서 직접 꺼낸다. 설정 파일·요청·로그 어디에도 값이 남지 않는다.
      { name: 'SPRING_DATASOURCE_PASSWORD', valueSource: { secretKeyRef: { secret: c.dbPasswordSecret, version: 'latest' } } },
    ];
  }

  // 사설 IP의 Cloud SQL에 닿으려고 Direct VPC egress를 쓴다. 사설 대역만 VPC로 보내고 나머지는 그대로 인터넷으로 나간다.
  private vpcAccess(): RunVpcAccess {
    return { networkInterfaces: [{ network: this.config.network, subnetwork: this.config.subnetwork }], egress: 'PRIVATE_RANGES_ONLY' };
  }

  private job(request: DeployRequest): RunJob {
    const c = this.config;
    return { template: { taskCount: 1, template: {
      containers: [{ name: 'schema-init', image: request.image, env: this.env(request, true), resources: { limits: { memory: c.memory, cpu: c.cpu } } }],
      // 기본값은 재시도 3회다. 실패를 바로 알려야 270초 안에 원인이 로그에 남는다.
      maxRetries: 0,
      // 기본 600초는 배포 전체 제한(270초)보다 길다. 멈춘 Job은 그 전에 끊는다.
      timeout: '180s',
      vpcAccess: this.vpcAccess(),
    } } };
  }

  private service(request: DeployRequest): RunService {
    const c = this.config;
    return {
      template: {
        revision: this.revisionName(request.deployment_id),
        containers: [{
          name: 'app', image: request.image,
          // PORT는 넣지 않는다. Cloud Run이 containerPort 값으로 PORT를 넣어 주고, 문서는 직접 넣지 말라고 한다.
          ports: [{ containerPort: c.port }],
          env: this.env(request, false),
          // resources를 적으면 cpuIdle 기본값(true)이 꺼진다. 요청 기반 과금을 유지하려고 true를 적는다.
          resources: { limits: { memory: c.memory, cpu: c.cpu }, cpuIdle: true },
        }],
        vpcAccess: this.vpcAccess(),
        sessionAffinity: request.options.sticky_sessions,
      },
      // 수동 스케일링: 요청 대수를 그대로 띄우고, 0으로 바꾸면 새 리비전 없이 서비스가 꺼진다.
      scaling: { scalingMode: 'MANUAL', manualInstanceCount: request.options.replicas },
      // 공개 여부는 allUsers 권한 하나로만 다룬다. IAM 검사를 끄면 권한을 빼도 막히지 않는다.
      invokerIamDisabled: false,
    };
  }

  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    const existing = await this.run.getService(signal);
    // IAM 반영은 보통 2분, 길면 7분이다. 서비스가 있으면 맨 앞에서 권한을 줘서 Job·갱신 시간 동안 반영되게 한다.
    if (existing) await phase('grant_public', log, () => this.run.setPublic(true, signal));
    await phase('schema_job', log, () => this.run.runSchemaJob(this.job(request), signal));
    await phase('update_service', log, () => this.run.putService(this.service(request), signal));
    // 첫 배포는 서비스가 없어 권한을 붙일 곳이 없었다. 만든 직후에 준다.
    if (!existing) await phase('grant_public', log, () => this.run.setPublic(true, signal));
    const service = await phase('wait_ready', log, () => this.waitReady(request, signal));
    await phase('public_health', log, () => this.waitHttp(request.health_path, signal));
    log('public health check passed: HTTP 200 without cookies');
    return { url: this.run.serviceUrl(), instances: request.options.replicas, info: {
      runtime: 'Cloud Run', region: this.config.region, database: 'Cloud SQL PostgreSQL',
      session: this.profile(request).includes('session-jdbc') ? 'jdbc' : 'memory',
      sticky_sessions: String(request.options.sticky_sessions),
      image_digest: request.image.split('@')[1],
      revision: service.latestReadyRevision?.split('/').pop() ?? 'unknown',
      scaling: 'manual',
    } };
  }

  private async waitReady(request: DeployRequest, signal: AbortSignal): Promise<RunService> {
    while (true) {
      signal.throwIfAborted();
      const service = await this.run.getService(signal);
      if (!service) throw new Error('Cloud Run service disappeared during rollout');
      const condition = service.terminalCondition;
      if (!service.reconciling && condition?.state === 'CONDITION_FAILED') throw new Error(`Cloud Run rollout failed: ${condition.message ?? 'see Cloud Run revision logs'}`);
      // 조정이 성공으로 끝나면 latestReadyRevision = latestCreatedRevision, observedGeneration = generation이 된다(Service.reconciling 문서).
      // Revision 리소스에는 해석된 digest 칸이 없고 리비전은 이 template으로 만들어진다. 그래서 위 조건이 맞을 때 template의 image로 digest를 확인한다.
      if (condition?.type === 'Ready' && condition.state === 'CONDITION_SUCCEEDED' && !service.reconciling &&
        !!service.latestReadyRevision && service.latestReadyRevision === service.latestCreatedRevision &&
        service.observedGeneration === service.generation && service.template.containers[0]?.image === request.image) return service;
      await sleep(2_000, undefined, { signal });
    }
  }

  private async waitHttp(path: string, signal: AbortSignal) {
    const url = new URL(path, this.run.serviceUrl());
    while (true) {
      signal.throwIfAborted();
      try {
        // 리다이렉트를 따라가지 않고 쿠키도 보내지 않는다. 로그인 페이지로 보내는 302를 성공으로 착각하지 않으려고.
        const response = await this.fetchFn(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), headers: { 'Cache-Control': 'no-cache' } });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch { signal.throwIfAborted(); }
      await sleep(1_000, undefined, { signal });
    }
  }
}
