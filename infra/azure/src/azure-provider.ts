import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ContainerApp } from '@azure/arm-appcontainers';
import type { AzureApi } from './azure-client.js';
import type { Config } from './config.js';
import { validateRequest } from './config.js';
import type { DeployRequest, Provider, ReadyResult, Log, LogLine } from './model.js';
import { ApiError } from './model.js';
import { HTTP_CONCURRENCY, PLANNED_POOL_SIZE, shapeOf } from './architecture.js';
import { databaseEnvironment } from '../../../packages/contracts/runtime.mjs';

// ingress를 끈 뒤 공개 주소가 돌려주는 상태 코드 (2026-10-09 실측)
const CLOSED_STATUS = 404;

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
    if (['Stopped', 'Stopping'].includes(db.state)) throw new Error(`PostgreSQL 서버가 ${db.state} 상태입니다. az postgres flexible-server start로 먼저 켜세요 (수 분 걸림).`);
    return db;
  }
  validate(request: DeployRequest) { validateRequest(this.config, request); }
  async precheck(request: DeployRequest) {
    const manifest = await this.api.manifest(request.image.split('@')[1], AbortSignal.timeout(15_000));
    if (!manifest) throw new ApiError(400, 'ACR에 해당 digest 이미지가 없습니다. 엔진이 이미지를 ACR로 복사했는지 확인하세요.');
    if (manifest.multiArch || manifest.architecture !== 'amd64' || manifest.operatingSystem !== 'linux') throw new ApiError(400, '단일 linux/amd64 이미지 manifest가 필요합니다.');
  }
  // 이미지·환경변수·복제본·TZ·health 확인 경로·ingress를 한 번의 갱신에 담는다.
  private desired(app: ContainerApp, request: DeployRequest): ContainerApp {
    const c = this.config, shape = shapeOf(request);
    // 비밀번호는 Bicep이 만든 Key Vault 참조 secret을 이름으로만 가리킨다. 어댑터는 값을 모른다.
    const secret = app.configuration?.secrets?.find(s => s.name === 'db-password');
    if (secret?.keyVaultUrl?.replace(/\/$/, '') !== c.dbPasswordSecretUri.replace(/\/$/, '')) throw new Error('Container App의 db-password가 설정한 Key Vault 비밀을 가리키지 않습니다. provision.sh로 다시 준비하세요.');
    return {
      ...app,
      configuration: {
        ...app.configuration,
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
          name: 'app', image: request.image, resources: { cpu: shape.cpu, memory: shape.memory },
          env: request.runtime ? this.runtimeEnv(request) : [
            { name: 'SPRING_DATASOURCE_URL', value: `jdbc:postgresql://${c.dbHost}:5432/${c.dbName}?sslmode=require` },
            { name: 'SPRING_DATASOURCE_USERNAME', value: c.dbUsername },
            { name: 'SPRING_DATASOURCE_PASSWORD', secretRef: 'db-password' },
            { name: 'SPRING_JPA_HIBERNATE_DDL_AUTO', value: 'validate' },
            { name: 'SPRING_PROFILES_ACTIVE', value: request.env.SPRING_PROFILES_ACTIVE ?? 'demo,session-memory' },
            { name: 'SERVER_PORT', value: String(c.port) },
            { name: 'TZ', value: request.options.tz },
            // 계획 배포만: 인스턴스당 DB 연결 3개. 최대 대수까지 늘어도 B1ms 연결 한도 안에 든다.
            ...(request.architecture ? [{ name: 'SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE', value: PLANNED_POOL_SIZE }] : []),
          ],
          probes: [{ type: 'Readiness', httpGet: { path: request.health_path, port: c.port }, periodSeconds: 5, failureThreshold: 3 }],
        }],
        // 0으로 줄어들지 않게 최소를 시작 대수로 고정 (첫 요청 지연 방지). 자동 확장 등급만 HTTP 동시 요청으로 늘어난다.
        scale: { minReplicas: shape.min, maxReplicas: shape.max,
          rules: shape.scaling === 'AUTOMATIC' ? [{ name: 'http', http: { metadata: { concurrentRequests: HTTP_CONCURRENCY } } }] : [] },
      },
    };
  }
  // 범용 런타임의 환경변수: 앱 env + PORT·TZ + DB 바인딩. password 바인딩과 db_password 참조만 Key Vault 비밀로 연결한다.
  private runtimeEnv(request: DeployRequest) {
    const c = this.config, runtime = request.runtime!;
    const plain: Record<string, string> = { ...runtime.env, PORT: String(c.port), TZ: request.options.tz,
      ...(runtime.database.mode === 'postgres' ? databaseEnvironment(runtime, { host: c.dbHost, username: c.dbUsername, ssl: true }) : {}) };
    const secretNames = [...Object.keys(runtime.secret_refs), ...Object.entries(runtime.database.bindings).filter(([, v]) => v === 'password').map(([k]) => k)];
    return [...Object.entries(plain).map(([name, value]) => ({ name, value })), ...secretNames.map(name => ({ name, secretRef: 'db-password' }))];
  }
  async deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult> {
    const c = this.config, revision = revisionName(c, request.deployment_id), shape = shapeOf(request);
    await this.verifySubscription(signal); signal.throwIfAborted();
    const db = await this.verifyDatabase(signal);
    await phase('update_app', log, async () => this.api.putApp(this.desired(await this.api.getApp(signal), request), signal));
    log(`revision requested: ${revision}`);
    const actual = await phase('wait_revision', log, () => this.waitRevision(revision, request, signal));
    await phase('public_health', log, () => this.waitHttp(request.health_path, 200, signal));
    log('public health check passed: HTTPS 200 without cookies');
    return { url: c.publicUrl, instances: actual.replicas, info: {
      runtime: 'Azure Container Apps', database: 'Azure PostgreSQL Flexible 17', timezone: actual.tz,
      session: request.runtime ? 'app-defined' : actual.profile.includes('session-jdbc') ? 'jdbc' : 'memory', sticky_sessions: String(request.options.sticky_sessions),
      image_digest: request.image.split('@')[1], revision, transport: 'HTTPS',
      // AWS·GCP와 같은 키. scaling은 GCP와 같은 형식, DB 값은 배포 전에 읽은 실제 서버 값이다.
      architecture: request.architecture?.template_id ?? 'legacy',
      scaling: shape.scaling === 'AUTOMATIC' ? `automatic ${shape.min}-${shape.max}` : 'manual',
      ...(request.architecture ? { db_availability: db.highAvailability, db_tier: db.tier } : {}),
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
    log(`public route blocked: HTTP ${CLOSED_STATUS} confirmed; revision deactivated, PostgreSQL and Log Analytics retained`);
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
