import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { architectures, type Tier } from './architecture.js';
import type { Config } from './config.js';
import { validateRequest } from './config.js';
import type { CloudRun, RunEnv, RunJob, RunService, RunVpcAccess } from './cloud-run.js';
import { GcpError } from './gcp-http.js';
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

export class GcpProvider implements Provider {
  // 직전 stop이 뒤에서 하는 allUsers 제거. 다음 배포는 이것이 끝난 뒤에 권한을 다시 준다.
  private closing: Promise<void> = Promise.resolve();
  // stop이 공개 주소가 닫혔는지 확인하는 최대 시간. 테스트만 줄여 쓴다.
  stopWaitMs = 15_000;
  constructor(public config: Config, private run: CloudRun, private fetchFn: typeof fetch = fetch) {}
  // 서비스 주소에는 프로젝트 번호가, API 경로에는 프로젝트 ID가 들어간다. 둘이 다른 프로젝트를 가리키면 엉뚱한 곳을 만지므로 기동 때 막는다.
  async verifyProject(): Promise<void> {
    const project = await this.run.getProject(AbortSignal.timeout(15_000));
    if (project.name !== `projects/${this.config.gcpProjectNumber}` || project.projectId !== this.config.gcpProject) {
      throw new Error('GCP 프로젝트 ID와 번호가 설정과 다릅니다. 실행을 중단합니다.');
    }
  }

  validate(request: DeployRequest) { validateRequest(this.config, request); }

  // 배포마다 리비전 이름을 정해 둔다. 그래야 로그를 그 배포의 리비전으로만 거를 수 있다(AWS가 배포 ID별 로그 스트림을 쓰는 것과 같은 효과).
  // Cloud Run 리비전 이름은 "서비스 이름-"으로 시작하고 63자 이하여야 한다. 배포 ID는 60자까지라 해시 12자리로 줄인다.
  private revisionName(deploymentId: string) {
    return `${this.config.serviceName}-${createHash('sha256').update(deploymentId).digest('hex').slice(0, 12)}`;
  }

  private profile(request: DeployRequest) { return request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory'; }

  private env(request: DeployRequest, initialize: boolean): RunEnv[] {
    const c = this.config;
    const pool = request.architecture && !initialize ? architectures[request.architecture.template_id].pool : undefined;
    return [
      ...Object.entries({
        SPRING_DATASOURCE_URL: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}`,
        SPRING_DATASOURCE_USERNAME: c.dbUsername,
        // 테이블은 Job 한 곳에서만 고친다(update). 앱은 validate로 떠서 2대가 동시에 DDL을 돌리지 않게 한다.
        SPRING_JPA_HIBERNATE_DDL_AUTO: initialize ? 'update' : 'validate',
        SPRING_PROFILES_ACTIVE: initialize ? 'schema-init' : this.profile(request),
        TZ: request.options.tz,
        // 계획 배포 앱만: 등급별 인스턴스당 DB 연결 풀(기본 10). 최대 대수까지 늘어도 지금 Cloud SQL 연결 한도 안에 든다(architecture.ts).
        // 이름은 Spring 환경변수 규칙(점은 밑줄, 대시는 제거)을 따른다. schema Job, small, 계획 없는 배포는 기본값 그대로다.
        ...(pool !== undefined ? { SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE: String(pool) } : {}),
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
    // 계획이 없으면 지금까지와 같은 본문(설정 사양, 수동 대수)이다. 계획이 있으면 사양과 확장 방식은 카탈로그에서만 가져온다.
    const spec = request.architecture ? architectures[request.architecture.template_id] : undefined;
    const automatic = spec?.scaling === 'AUTOMATIC';
    return {
      template: {
        revision: this.revisionName(request.deployment_id),
        containers: [{
          name: 'app', image: request.image,
          // PORT는 넣지 않는다. Cloud Run이 containerPort 값으로 PORT를 넣어 주고, 문서는 직접 넣지 말라고 한다.
          ports: [{ containerPort: c.port }],
          env: this.env(request, false),
          // resources를 적으면 cpuIdle 기본값(true)이 꺼진다. 요청 기반 과금을 유지하려고 true를 적는다.
          resources: { limits: { memory: spec?.memory ?? c.memory, cpu: spec?.cpu ?? c.cpu }, cpuIdle: true },
        }],
        vpcAccess: this.vpcAccess(),
        sessionAffinity: request.options.sticky_sessions,
        // 리비전 상한도 서비스 상한과 같게 적는다. 안 적으면 서버가 채운 값(2026-10-09 GET에서 3)이 남아 그보다 먼저 막는다.
        ...(automatic ? { scaling: { maxInstanceCount: spec.max } } : {}),
      },
      // 수동 스케일링: 요청 대수를 그대로 띄우고, 0으로 바꾸면 새 리비전 없이 서비스가 꺼진다.
      // 자동 확장(계획 medium·large): min대를 늘 띄우고 부하(기본 CPU 60%)에 따라 max대까지 늘린다.
      // 업데이트 마스크 없이 전체를 바꾸므로, 다음 계획 없는 배포는 min/max가 지워진 수동 모드로 돌아간다.
      scaling: automatic
        ? { scalingMode: 'AUTOMATIC', minInstanceCount: spec.min, maxInstanceCount: spec.max }
        : { scalingMode: 'MANUAL', manualInstanceCount: request.options.replicas },
      // 공개 여부는 allUsers 권한 하나로만 다룬다. IAM 검사를 끄면 권한을 빼도 막히지 않는다.
      invokerIamDisabled: false,
    };
  }

  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    // 직전 stop의 allUsers 제거가 아직 돌고 있으면, 그것이 이번 배포가 줄 권한을 나중에 지워 버릴 수 있다. 끝나길 먼저 기다린다.
    await this.closing;
    const plan = request.architecture;
    const existing = await this.run.getService(signal);
    // IAM 반영은 보통 2분, 길면 7분이다. 서비스가 있으면 맨 앞에서 권한을 줘서 Job·갱신 시간 동안 반영되게 한다.
    if (existing) await phase('grant_public', log, () => this.run.setPublic(true, signal));
    await phase('schema_job', log, () => this.run.runSchemaJob(this.job(request), signal));
    await phase('update_service', log, () => this.run.putService(this.service(request), signal));
    // 첫 배포는 서비스가 없어 권한을 붙일 곳이 없었다. 만든 직후에 준다.
    if (!existing) await phase('grant_public', log, () => this.run.setPublic(true, signal));
    const service = await phase('wait_ready', log, () => this.waitReady(request, signal));
    // 공개 확인(public_health) 전에 실제로 적용된 확장 범위를 확인한다. 카탈로그와 다르면 여기서 실패하고 Manager가 0대로 내린다.
    // "공개 전"은 아니다. 이미 있는 서비스는 grant_public이 맨 앞이라 이때 새 리비전이 이미 공개 주소로 트래픽을 받고 있다.
    // 실패가 로그에서 이 단계로 보이게 phase로 감싼다. 계획 없는 배포는 확인할 범위가 없어 단계 로그도 전과 같다.
    const scaling = plan ? await phase('verify_scaling', log, async () => this.actualScaling(architectures[plan.template_id], service)) : 'manual';
    await phase('public_health', log, () => this.waitHttp(request.health_path, signal));
    log('public health check passed: HTTP 200 without cookies');
    return { url: this.run.serviceUrl(), instances: request.options.replicas, info: {
      runtime: 'Cloud Run', region: this.config.region, database: 'Cloud SQL PostgreSQL',
      session: this.profile(request).includes('session-jdbc') ? 'jdbc' : 'memory',
      sticky_sessions: String(request.options.sticky_sessions),
      image_digest: request.image.split('@')[1],
      revision: service.latestReadyRevision?.split('/').pop() ?? 'unknown',
      scaling,
      // 등급, 계획이 없으면 legacy(AWS·Azure 어댑터와 같은 키). DB 고가용성은 계획에만 있고 적용하지 않으므로 info에 적지 않는다.
      architecture: plan?.template_id ?? 'legacy',
    } };
  }

  // 서버가 리비전 상한을 따로 채우는 일이 있다(2026-10-09 v2 GET에서 template.scaling.maxInstanceCount=3 확인).
  // 실제 상한은 서비스·리비전 max 중 작은 값이라, 다시 읽은 범위가 카탈로그와 다르면 info와 화면이 거짓 범위를 보이지 않게 실패한다.
  private actualScaling(spec: (typeof architectures)[Tier], service: RunService): string {
    if (spec.scaling === 'MANUAL') return 'manual';
    const min = service.scaling?.minInstanceCount;
    const maxes = [service.scaling?.maxInstanceCount, service.template.scaling?.maxInstanceCount].filter((n): n is number => n !== undefined);
    const max = maxes.length ? Math.min(...maxes) : undefined;
    // 자동 확장은 API 기본 모드라 응답에서 scalingMode가 빠질 수 있다. MANUAL로 읽힐 때만 다른 것으로 본다.
    if (service.scaling?.scalingMode === 'MANUAL' || min !== spec.min || max !== spec.max) {
      throw new Error(`Cloud Run 자동 확장 범위가 카탈로그와 다릅니다: 기대 ${spec.min}-${spec.max}, 실제 ${service.scaling?.scalingMode ?? 'AUTOMATIC'} ${min ?? '?'}-${max ?? '?'}`);
    }
    return `automatic ${min}-${max}`;
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

  async stop(log: Log) {
    // 엔진은 DELETE를 20초만 기다린다. 그 안에 끝내거나 실패를 돌려주려고 전체를 19초로 묶는다.
    const signal = AbortSignal.timeout(19_000);
    if (!(await this.run.getService(signal))) { log('Cloud Run service not found; nothing to stop'); return; }
    try {
      await this.run.setInstances(0, signal);
      log('Cloud Run manual instance count set to 0');
      await this.waitClosed(signal);
      log('public URL closed: no success response');
    } finally {
      // IAM 반영(2~7분)은 20초 안에 확인할 수 없다. 0대로 이미 닫았으니 allUsers 제거는 기다리지 않고 뒤에서 하고 결과만 로그로 남긴다.
      // 앞선 제거 뒤에 줄을 세워, 늦게 끝난 제거가 다음 배포의 권한 부여를 덮어쓰지 않게 한다.
      this.closing = this.closing
        .then(() => this.run.setPublic(false, AbortSignal.timeout(30_000)))
        .then(() => log('public access revoked: allUsers removed'), (error: unknown) => log(`public access revoke failed: ${error instanceof Error ? error.message : String(error)}`))
        .catch(() => {}); // log 자체가 실패해도 처리 안 된 거부로 프로세스가 죽지 않게 한다.
    }
  }

  // 뒤에서 도는 공개 권한 제거가 끝날 때까지 기다린다. 프로세스를 끄기 전에 불러야 allUsers가 남지 않는다.
  async settled(): Promise<void> { await this.closing; }

  private async waitClosed(signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.stopWaitMs)]);
    while (!deadline.aborted) {
      try {
        const response = await this.fetchFn(this.run.serviceUrl(), { redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]), headers: { 'Cache-Control': 'no-cache' } });
        await response.body?.cancel();
        // 2xx·3xx는 앱이 아직 답한다는 뜻이다. 4xx·5xx(꺼짐·권한 없음)가 나와야 닫힌 것으로 본다.
        if (response.status >= 400) return;
      } catch { /* 네트워크 오류는 닫혔다는 증거가 아니다. 다시 확인한다. */ }
      await sleep(1_000, undefined, { signal: deadline }).catch(() => {});
    }
    throw new Error(`공개 주소가 ${this.stopWaitMs / 1000}초 안에 닫히지 않았습니다. DELETE를 다시 요청하세요.`);
  }

  async appLogs(deploymentId: string, since?: string): Promise<LogLine[]> {
    try { return await this.run.readLogs(this.revisionName(deploymentId), since, AbortSignal.timeout(15_000)); }
    catch (error) {
      // 로그 읽기는 프로젝트당 분당 60회이고 올릴 수 없다. 넘으면 앱 로그만 비우고 배포 로그는 그대로 보여 준다.
      if (error instanceof GcpError && error.status === 429) return [];
      throw error;
    }
  }
}
