import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { KnownJobExecutionRunningState as JobState, type ContainerApp, type EnvironmentVar, type Job, type JobExecutionContainer, type Secret } from '@azure/arm-appcontainers';
import type { AzureApi, DatabaseStatus } from './azure-client.js';
import type { Config, DbEngine } from './config.js';
import { DATABASE_ENGINES, secretRefName, secretUris, validateRequest } from './config.js';
import type { DeployRequest, Provider, ReadyResult, Log, LogLine } from './model.js';
import { ApiError } from './model.js';
import { HTTP_CONCURRENCY, PLANNED_POOL_SIZE, shapeOf } from './architecture.js';
import { databaseEnvironment, managedDatabase } from '../../../packages/contracts/runtime.mjs';

// ingress를 끈 뒤 공개 주소가 돌려주는 상태 코드 (2026-10-09 실측)
const CLOSED_STATUS = 404;
// 작업 실행이 실패로 끝난 상태
const JOB_FAILED: string[] = [JobState.Failed, JobState.Stopped, JobState.Degraded];

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

// 배포 ID마다 고정된 리비전 이름. 상태 확인과 로그 조회에 같은 이름을 쓴다.
export function revisionSuffix(deploymentId: string) { return 'd' + createHash('sha256').update(deploymentId).digest('hex').slice(0, 12); }
export function revisionName(config: Pick<Config, 'containerApp'>, deploymentId: string) { return `${config.containerApp}--${revisionSuffix(deploymentId)}`; }
// 앱이 실제로 쓰는 DB 모드. 기존 Spring 샘플 요청은 스택의 PostgreSQL을 쓴다.
const databaseMode = (request: DeployRequest) => request.runtime?.database.mode ?? 'postgres';
// DB를 쓰지 않는 런타임이면 스택의 DB가 있어도 'none'으로 적는다 (앱이 실제로 쓰는 것만 보고).
function databaseLabel(engine: DbEngine, request: DeployRequest, db?: DatabaseStatus) {
  const mode = databaseMode(request);
  // info.database: 엔진 이름에 배포 전에 읽은 실제 서버 버전을 붙인다.
  return mode === 'none' ? 'none' : mode === 'external' ? 'external (app-defined)' : `${DATABASE_ENGINES[engine].label} ${db?.version ?? 'unknown'}`;
}

export class AzureProvider implements Provider {
  constructor(public config: Config, public api: AzureApi, private pollMs = 2_000) {}
  async verifySubscription(signal: AbortSignal = AbortSignal.timeout(30_000)) {
    const identity = await this.api.identity(signal);
    // 회사 계정 등 다른 테넌트/구독으로 로그인돼 있으면 아무것도 바꾸지 않고 멈춘다.
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!same(identity.tenantId, this.config.tenantId)) throw new Error('az login 테넌트가 설정과 다릅니다. 실행을 중단합니다.');
    if (!same(identity.subscriptionId, this.config.subscriptionId) || !same(identity.subscriptionTenantId, this.config.tenantId)) throw new Error('Azure 구독이 설정과 다릅니다. 실행을 중단합니다.');
    if (identity.state !== 'Enabled') throw new Error(`Azure 구독 상태가 ${identity.state}입니다.`);
  }
  async verifyDatabase(signal: AbortSignal = AbortSignal.timeout(30_000)) {
    const db = await this.api.databaseState(signal);
    if (['Stopped', 'Stopping'].includes(db.state)) throw new Error(`${DATABASE_ENGINES[this.config.dbEngine].label} 서버가 ${db.state} 상태입니다. 먼저 켜세요 (수 분 걸림).`);
    return db;
  }
  validate(request: DeployRequest) { validateRequest(this.config, request); }
  async precheck(request: DeployRequest) {
    const manifest = await this.api.manifest(request.image.split('@')[1], AbortSignal.timeout(15_000));
    if (!manifest) throw new ApiError(400, 'ACR에 해당 digest 이미지가 없습니다. 엔진이 이미지를 ACR로 복사했는지 확인하세요.');
    if (manifest.multiArch || manifest.architecture !== 'amd64' || manifest.operatingSystem !== 'linux') throw new ApiError(400, '단일 linux/amd64 이미지 manifest가 필요합니다.');
  }
  // 이미지·환경변수·복제본·TZ·health 확인 경로·ingress를 한 번의 갱신에 담는다.
  private desired(app: ContainerApp, request: DeployRequest, env: EnvironmentVar[]): ContainerApp {
    const c = this.config, shape = shapeOf(request);
    return {
      ...app,
      configuration: {
        ...app.configuration,
        secrets: this.secrets(app, env),
        activeRevisionsMode: 'Single',
        ingress: {
          external: true, targetPort: c.port, transport: 'auto', allowInsecure: false,
          stickySessions: { affinity: request.options.sticky_sessions ? 'sticky' : 'none' },
          traffic: [{ latestRevision: true, weight: 100 }],
        },
      },
      template: {
        ...app.template,
        revisionSuffix: revisionSuffix(request.deployment_id),
        containers: [{
          // 매번 전체 템플릿을 보내므로 자원도 이번 모양으로 다시 쓴다(이전 계획 배포의 자원이 남지 않게).
          name: 'app', image: request.image, resources: { cpu: shape.cpu, memory: shape.memory }, env,
          probes: [{ type: 'Readiness', httpGet: { path: request.health_path, port: c.port }, periodSeconds: 5, failureThreshold: 3 }],
        }],
        // 0으로 줄어들지 않게 최소를 시작 대수로 고정 (첫 요청 지연 방지). 자동 확장 등급만 HTTP 동시 요청으로 늘어난다.
        scale: { minReplicas: shape.min, maxReplicas: shape.max,
          rules: shape.scaling === 'AUTOMATIC' ? [{ name: 'http', http: { metadata: { concurrentRequests: HTTP_CONCURRENCY } } }] : [] },
      },
    };
  }
  // 앱(과 초기화 작업)의 환경변수. 비밀값은 전부 Key Vault 참조 secret의 이름으로만 연결하고 어댑터는 값을 모른다.
  private env(request: DeployRequest): EnvironmentVar[] {
    const c = this.config, runtime = request.runtime;
    if (!runtime) return [
      // 기존 Spring 샘플 계약 (PostgreSQL 스택 전용, validateRequest가 보장)
      { name: 'SPRING_DATASOURCE_URL', value: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}?sslmode=require` },
      { name: 'SPRING_DATASOURCE_USERNAME', value: c.dbUsername },
      { name: 'SPRING_DATASOURCE_PASSWORD', secretRef: 'db-password' },
      { name: 'SPRING_JPA_HIBERNATE_DDL_AUTO', value: 'validate' },
      { name: 'SPRING_PROFILES_ACTIVE', value: request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory' },
      { name: 'SERVER_PORT', value: String(c.port) },
      { name: 'TZ', value: request.options.tz },
      // 계획 배포만: 인스턴스당 DB 연결 3개. 최대 대수까지 늘어도 B1ms 연결 한도 안에 든다.
      ...(request.architecture ? [{ name: 'SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE', value: PLANNED_POOL_SIZE }] : []),
    ];
    // 범용 런타임: 앱 env + PORT·TZ + 관리 DB의 평문 바인딩(host·port·name·username·jdbc_url).
    const plain: Record<string, string> = { ...runtime.env, PORT: String(c.port), TZ: request.options.tz,
      ...(managedDatabase(runtime.database.mode) ? databaseEnvironment(runtime, { host: c.dbHost, username: c.dbUsername, ssl: true }) : {}) };
    // password 바인딩 → db-password, *_url 바인딩 → db-url(Bicep이 비밀번호를 넣어 만든 URL), secret_refs → 등록된 비밀
    const refs: EnvironmentVar[] = [
      ...Object.entries(runtime.secret_refs).map(([name, reference]) => ({ name, secretRef: secretRefName(reference) })),
      ...Object.entries(runtime.database.bindings).flatMap(([name, binding]) =>
        // URL 바인딩은 모드와 같은 엔진만 온다 (validateRuntime). jdbc_url은 비밀번호가 없어 평문이다.
        binding === 'password' ? [{ name, secretRef: 'db-password' }] : binding === `${runtime.database.mode}_url` ? [{ name, secretRef: 'db-url' }] : []),
    ];
    return [...Object.entries(plain).map(([name, value]) => ({ name, value })), ...refs];
  }
  // 이번 env가 참조하는 Key Vault 비밀만 Container App secret으로 둔다 (db-password는 항상). 관리 ID는 Bicep이 붙인 것을 그대로 쓴다.
  // 참조할 비밀은 validateRequest가 설정에 있는 것만 통과시킨다.
  private secrets(resource: ContainerApp | Job, env: EnvironmentVar[]): Secret[] {
    // Bicep이 만든 db-password 항목이 이 스택의 Key Vault와 관리 ID를 알려 준다. 다른 스택이면 덮어쓰지 않고 멈춘다.
    const current = resource.configuration?.secrets?.find(s => s.name === 'db-password');
    if (!current?.identity || current.keyVaultUrl?.replace(/\/$/, '') !== this.config.dbPasswordSecretUri.replace(/\/$/, '')) throw new Error('Container App의 db-password가 설정한 Key Vault 비밀을 가리키지 않습니다. provision.sh로 다시 준비하세요.');
    const uris = Object.fromEntries(Object.entries(secretUris(this.config)).map(([reference, uri]) => [secretRefName(reference), uri]));
    const needed = new Set(['db-password', ...env.flatMap(e => e.secretRef ? [e.secretRef] : [])]);
    return [...needed].map(name => ({ name, keyVaultUrl: uris[name], identity: current.identity }));
  }
  // runtime.init_command를 같은 이미지·환경변수로 Container Apps 작업에서 한 번 실행하고 끝날 때까지 기다린다 (AWS schema_init과 같은 단계).
  // 이미지·명령·환경변수는 이번 실행에만 넘기고, 작업 자체는 비밀 목록이 바뀔 때만 갱신한다.
  private async runInit(request: DeployRequest, env: EnvironmentVar[], signal: AbortSignal, log: Log) {
    const [entrypoint, ...args] = request.runtime!.init_command, shape = shapeOf(request);
    const job = await this.api.getJob(signal), secrets = this.secrets(job, env);
    const listed = (list: Secret[] = []) => JSON.stringify(list.map(({ name, keyVaultUrl, identity }) => ({ name, keyVaultUrl, identity })));
    if (listed(job.configuration?.secrets) !== listed(secrets)) await this.api.putJob({ ...job, configuration: { ...job.configuration!, secrets } }, signal);
    const container: JobExecutionContainer = { name: 'init', image: request.image, command: [entrypoint], args, env, resources: { cpu: shape.cpu, memory: shape.memory } };
    const execution = await this.api.startJob(container, signal);
    log(`init execution started: ${execution}`);
    while (true) {
      signal.throwIfAborted();
      const status = await this.api.jobExecutionStatus(execution, signal);
      if (status === JobState.Succeeded) return;
      if (status && JOB_FAILED.includes(status)) throw new Error(`초기화 명령이 ${status}로 끝났습니다. az containerapp job logs show -n ${this.config.initJob} -g ${this.config.resourceGroup} 로 확인하세요.`);
      await sleep(this.pollMs, undefined, { signal });
    }
  }
  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    const c = this.config, revision = revisionName(c, request.deployment_id), shape = shapeOf(request);
    await this.verifySubscription(signal); signal.throwIfAborted();
    // 스택 DB를 쓰는 배포(또는 info에 DB 등급이 필요한 계획 배포)만 서버 상태를 확인한다.
    const db = managedDatabase(databaseMode(request)) || request.architecture ? await this.verifyDatabase(signal) : undefined;
    // 초기화 작업과 앱이 같은 환경변수를 쓴다.
    const env = this.env(request);
    if (request.runtime?.init_command.length) await phase('schema_init', log, () => this.runInit(request, env, signal, log));
    await phase('update_app', log, async () => this.api.putApp(this.desired(await this.api.getApp(signal), request, env), signal));
    log(`revision requested: ${revision}`);
    const actual = await phase('wait_revision', log, () => this.waitRevision(revision, request, signal));
    await phase('public_health', log, () => this.waitHttp(request.health_path, 200, signal));
    log('public health check passed: HTTPS 200 without cookies');
    return { url: c.publicUrl, instances: actual.replicas, info: {
      runtime: 'Azure Container Apps', database: databaseLabel(c.dbEngine, request, db), timezone: actual.tz,
      session: request.runtime ? 'app-defined' : actual.profile.includes('session-jdbc') ? 'jdbc' : 'memory', sticky_sessions: String(request.options.sticky_sessions),
      image_digest: request.image.split('@')[1], revision, transport: 'HTTPS',
      // AWS·GCP와 같은 키. scaling은 GCP와 같은 형식, DB 값은 배포 전에 읽은 실제 서버 값이다.
      architecture: request.architecture?.template_id ?? 'legacy',
      scaling: shape.scaling === 'AUTOMATIC' ? `automatic ${shape.min}-${shape.max}` : 'manual',
      ...(request.architecture && db ? { db_availability: db.highAvailability, db_tier: db.tier } : {}),
    } };
  }
  private async waitRevision(name: string, request: DeployRequest, signal: AbortSignal) {
    const minReplicas = shapeOf(request).min;
    while (true) {
      signal.throwIfAborted();
      const revision = await this.api.getRevision(name, signal), replicas = revision?.replicas ?? 0;
      if (revision?.provisioningState === 'Failed' || revision?.runningState === 'Failed') throw new Error(`리비전 실패: ${revision.provisioningError ?? revision.runningState}`);
      const container = revision?.template?.containers?.find(v => v.name === 'app');
      if (revision && container?.image !== request.image) throw new Error('리비전 이미지가 요청한 digest와 다릅니다.');
      // runningState는 실패 판단에만 쓴다. 정상 값은 SDK에 없는 것도 온다 (최소=최대 복제본이면 'RunningAtMaxScale', 2026-10-09 실측).
      if (revision?.provisioningState === 'Provisioned' && revision.active && revision.healthState === 'Healthy' &&
        // 자동 확장이 있으면 시작 대수보다 많을 수 있어 '최소 이상'으로 본다.
        revision.trafficWeight === 100 && replicas >= minReplicas && (await this.api.getApp(signal)).latestReadyRevisionName === name) {
        const env = Object.fromEntries(container?.env?.map(e => [e.name, e.value]) ?? []);
        return { replicas, tz: env.TZ ?? 'unknown', profile: env.SPRING_PROFILES_ACTIVE ?? 'unknown' };
      }
      await sleep(this.pollMs, undefined, { signal });
    }
  }
  private async waitHttp(path: string, expected: number, signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();
      try {
        const response = await fetch(new URL(path, this.config.publicUrl), { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), headers: { 'Cache-Control': 'no-cache' } });
        await response.body?.cancel();
        if (response.status === expected) return;
      } catch { signal.throwIfAborted(); }
      await sleep(Math.min(this.pollMs, 1_000), undefined, { signal });
    }
  }
  async stop(log: Log) {
    const signal = AbortSignal.timeout(120_000);
    await this.verifySubscription(signal);
    const app = await this.api.getApp(signal);
    if (app.configuration?.ingress) await this.api.putApp({ ...app, configuration: { ...app.configuration, ingress: undefined } }, signal);
    // 단일 리비전 모드라 활성 리비전은 하나. 비활성화하면 복제본이 0이 된다.
    const active = app.latestRevisionName ? await this.api.getRevision(app.latestRevisionName, signal) : undefined;
    if (active?.active) await this.api.deactivateRevision(app.latestRevisionName!, signal);
    await this.waitHttp('/', CLOSED_STATUS, signal);
    log(`public route blocked: HTTP ${CLOSED_STATUS} confirmed; revision deactivated, database and Log Analytics retained`);
  }
  async appLogs(id: string, since?: string): Promise<LogLine[]> {
    const signal = AbortSignal.timeout(15_000), revision = revisionName(this.config, id);
    // 리비전 이름은 [a-z0-9-]만 쓰므로 KQL에 그대로 넣어도 안전하다.
    const query = `union isfuzzy=true
  (ContainerAppConsoleLogs_CL | where RevisionName_s == '${revision}' | project ts=TimeGenerated, source='app', line=Log_s),
  (ContainerAppSystemLogs_CL | where RevisionName_s == '${revision}' | project ts=TimeGenerated, source='deploy', line=Log_s)
| top 50 by ts desc`;
    const [recent, older] = await Promise.allSettled([this.api.streamLogs(revision, signal), this.api.queryLogs(query, since ? new Date(since) : undefined, signal)]);
    if (recent.status === 'rejected' && older.status === 'rejected') throw recent.reason;
    const rows = [...(recent.status === 'fulfilled' ? recent.value : []), ...(older.status === 'fulfilled' ? older.value : [])];
    // 두 경로에 같은 줄이 겹칠 수 있어 시각(초)과 내용으로 한 번만 남긴다.
    const unique = new Map(rows.filter(r => !since || r.ts >= since).map(r => [`${r.ts.slice(0, 19)}|${r.line}`, r]));
    return [...unique.values()].map(r => ({ ts: r.ts, source: r.source === 'app' ? 'app' as const : 'deploy' as const, line: r.line }))
      .sort((a, b) => a.ts.localeCompare(b.ts)).slice(-50);
  }
}
