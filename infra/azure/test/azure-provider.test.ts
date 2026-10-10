import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ContainerApp, Job, JobExecutionContainer, Revision } from '@azure/arm-appcontainers';
import type { AzureApi, Identity, Manifest, LogRow } from '../src/azure-client.js';
import { AzureProvider, revisionName } from '../src/azure-provider.js';
import { configSchema } from '../src/config.js';
import { requestSchema } from '../src/model.js';
import { AZURE_ARCHITECTURE_VERSION, type Tier } from '../src/architecture.js';

const config = configSchema.parse(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
const image = config.repositoryUri + '@sha256:' + 'a'.repeat(64);
const request = requestSchema.parse({ deployment_id: 'dep_test', project_id: config.projectId, image, port: 8080, health_path: '/', options: { replicas: 2, sticky_sessions: true }, env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } });

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
// Container Apps를 흉내 내는 가짜. 새 리비전은 두 번째 조회부터 정상이 된다.
class FakeAzure implements AzureApi {
  actions: string[] = []; puts: ContainerApp[] = []; queries: string[] = [];
  identityValue: Identity = { tenantId: config.tenantId, subscriptionId: config.subscriptionId, subscriptionTenantId: config.tenantId, state: 'Enabled' };
  dbState = 'Ready'; readyReplicas?: number;
  // 초기화 작업: 실행은 두 번째 조회부터 끝난 것으로 본다
  job: Mutable<Job> = { location: 'koreacentral', identity: { type: 'UserAssigned', userAssignedIdentities: { '/identity': {} } }, configuration: { triggerType: 'Manual', replicaTimeout: 600, secrets: [{ name: 'db-password', keyVaultUrl: config.dbPasswordSecretUri, identity: '/identity' }] }, template: { containers: [{ name: 'init', image: 'old' }] } };
  jobPuts: Job[] = []; jobStarts: JobExecutionContainer[] = []; jobResult = 'Succeeded'; executions = new Map<string, number>();
  manifestValue: Manifest | undefined = { architecture: 'amd64', operatingSystem: 'linux', multiArch: false };
  app: Mutable<ContainerApp> = { location: 'koreacentral', configuration: { secrets: [{ name: 'db-password', keyVaultUrl: config.dbPasswordSecretUri, identity: '/identity' }] }, template: { containers: [{ name: 'app', image: 'old', resources: { cpu: 0.5, memory: '1Gi' } }] } };
  revisions = new Map<string, Mutable<Revision> & { polls: number }>();
  revisionImage?: string; neverReady = false; streamFails = false;
  async identity() { this.actions.push('identity'); return this.identityValue; }
  async databaseState() { return { state: this.dbState, version: '17', highAvailability: 'Disabled', tier: 'Standard_B1ms' }; }
  async getApp() { return structuredClone(this.app) as ContainerApp; }
  async putApp(app: ContainerApp) {
    this.actions.push(app.configuration?.ingress ? 'put:open' : 'put:closed'); this.puts.push(structuredClone(app));
    const name = `${config.containerApp}--${app.template?.revisionSuffix}`;
    if (app.template?.revisionSuffix && !this.revisions.has(name)) {
      for (const r of this.revisions.values()) Object.assign(r, { active: false, trafficWeight: 0 });
      this.revisions.set(name, { polls: 0, template: { containers: [{ ...app.template.containers![0], image: this.revisionImage ?? app.template.containers![0].image }] } });
      this.app.latestRevisionName = name;
    }
    Object.assign(this.app, { configuration: structuredClone(app.configuration), template: structuredClone(app.template) });
    return this.getApp();
  }
  async getRevision(name: string) {
    const revision = this.revisions.get(name);
    if (!revision) return undefined;
    if (++revision.polls >= 2 && !this.neverReady && revision.polls < 1000) {
      Object.assign(revision, { provisioningState: 'Provisioned', active: true, healthState: 'Healthy', runningState: 'RunningAtMaxScale', trafficWeight: 100, replicas: this.readyReplicas ?? this.app.template?.scale?.minReplicas, polls: 1000 });
      this.app.latestReadyRevisionName = name;
    } else if (revision.polls < 1000) Object.assign(revision, { provisioningState: 'Provisioning', runningState: 'Processing' });
    return structuredClone(revision) as Revision;
  }
  async deactivateRevision(name: string) { this.actions.push('deactivate'); Object.assign(this.revisions.get(name)!, { active: false, replicas: 0, trafficWeight: 0 }); }
  async getJob() { return structuredClone(this.job) as Job; }
  async putJob(job: Job) { this.actions.push('put:job'); this.jobPuts.push(structuredClone(job)); Object.assign(this.job, structuredClone(job)); return this.getJob(); }
  async startJob(container: JobExecutionContainer) { this.actions.push('start:job'); this.jobStarts.push(structuredClone(container)); const name = `exec-${this.executions.size + 1}`; this.executions.set(name, 0); return name; }
  async jobExecutionStatus(name: string) { const polls = this.executions.get(name)! + 1; this.executions.set(name, polls); return polls >= 2 ? this.jobResult : 'Running'; }
  async manifest() { return this.manifestValue; }
  async streamLogs(): Promise<LogRow[]> {
    if (this.streamFails) throw new Error('stream down');
    return [{ ts: '2026-10-09T01:00:02.000Z', source: 'app', line: 'GET / 200' }, { ts: '2026-10-09T01:00:00.400Z', source: 'app', line: 'Started BoardApplication' }];
  }
  async queryLogs(query: string): Promise<LogRow[]> { this.queries.push(query); return [{ ts: '2026-10-09T01:00:01.000Z', source: 'deploy', line: 'Pulling image' }, { ts: '2026-10-09T01:00:00.000Z', source: 'app', line: 'Started BoardApplication' }]; }
  // 공개 주소 응답: ingress가 켜져 있고 활성 리비전이 정상일 때만 200, 아니면 404
  get status() {
    const active = [...this.revisions.values()].find(r => r.active && r.healthState === 'Healthy');
    return this.app.configuration?.ingress && active ? 200 : 404;
  }
}
function setup(t: { mock: { method: Function } }, c = config) {
  const api = new FakeAzure(); const provider = new AzureProvider(c, api, 1);
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(options.redirect, 'manual'); assert.ok(!('Cookie' in (options.headers ?? {})));
    assert.equal(url.protocol, 'https:'); fetched.push(`${url.pathname}:${api.status}`);
    return new Response('', { status: api.status });
  });
  return { api, provider, fetched };
}

test('one update carries image, env, replicas, TZ, health probe and HTTPS ingress; ready only after a healthy revision', async t => {
  const { api, provider, fetched } = setup(t);
  const logs: string[] = [];
  const result = await provider.deploy(request, AbortSignal.timeout(5_000), line => logs.push(line));
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), ['put:open']);
  const app = api.puts[0], container = app.template!.containers![0];
  const env = Object.fromEntries(container.env!.map(e => [e.name, e.value ?? `secretRef:${e.secretRef}`]));
  assert.equal(container.image, image);
  assert.equal(env.SPRING_DATASOURCE_PASSWORD, 'secretRef:db-password');
  assert.equal(env.SPRING_DATASOURCE_URL, `jdbc:postgresql://${config.dbHost}:5432/${config.dbName}?sslmode=require`);
  assert.equal(env.SPRING_PROFILES_ACTIVE, 'demo,session-jdbc'); assert.equal(env.TZ, 'UTC');
  assert.deepEqual(container.probes, [{ type: 'Readiness', httpGet: { path: '/', port: 8080 }, periodSeconds: 5, failureThreshold: 3 }]);
  assert.deepEqual(container.resources, { cpu: 0.5, memory: '1Gi' });
  assert.deepEqual(app.template!.scale, { minReplicas: 2, maxReplicas: 2, rules: [] });
  // 비밀값은 Bicep이 만든 Key Vault 참조를 그대로 둔다. 어댑터가 값을 넣지 않는다.
  assert.deepEqual(app.configuration!.secrets, api.app.configuration!.secrets);
  assert.ok(!app.configuration!.secrets!.some(s => 'value' in s));
  const ingress = app.configuration!.ingress!;
  assert.equal(ingress.allowInsecure, false); assert.equal(ingress.external, true);
  assert.deepEqual(ingress.stickySessions, { affinity: 'sticky' });
  assert.equal(app.configuration!.activeRevisionsMode, 'Single');
  assert.ok(fetched.length >= 1 && fetched.at(-1) === '/:200');
  assert.equal(result.instances, 2); assert.equal(result.url, config.publicUrl);
  assert.deepEqual(result.info, {
    runtime: 'Azure Container Apps', database: 'Azure PostgreSQL Flexible 17', timezone: 'UTC', session: 'jdbc', sticky_sessions: 'true',
    image_digest: 'sha256:' + 'a'.repeat(64), revision: revisionName(config, 'dep_test'), transport: 'HTTPS', architecture: 'legacy', scaling: 'manual',
  });
  assert.ok(!('commands' in result));
  assert.ok(logs.some(l => l.startsWith('phase=wait_revision completed')));
});

test('a revision running a different image is never reported ready', async t => {
  const { api, provider } = setup(t);
  api.revisionImage = config.repositoryUri + '@sha256:' + 'b'.repeat(64);
  await assert.rejects(provider.deploy(request, AbortSignal.timeout(5_000), () => {}), /digest/);
});

test('a revision that never becomes healthy runs into the deadline', async t => {
  const { api, provider, fetched } = setup(t);
  api.neverReady = true;
  await assert.rejects(provider.deploy(request, AbortSignal.timeout(300), () => {}));
  assert.equal(fetched.length, 0);
});

test('wrong tenant, subscription or disabled subscription stops before any change', async t => {
  for (const identity of [{ tenantId: '11111111-1111-1111-1111-111111111111' }, { subscriptionId: '22222222-2222-2222-2222-222222222222' }, { state: 'Disabled' }]) {
    const { api, provider } = setup(t);
    api.identityValue = { ...api.identityValue, ...identity };
    await assert.rejects(provider.deploy(request, AbortSignal.timeout(1_000), () => {}));
    await assert.rejects(provider.stop(() => {}));
    assert.deepEqual(api.actions.filter(a => a !== 'identity'), []);
  }
});

test('a stopped PostgreSQL server or a foreign Key Vault reference stops before any change', async t => {
  const stopped = setup(t); stopped.api.dbState = 'Stopped';
  await assert.rejects(stopped.provider.verifyDatabase(), /PostgreSQL/);
  await assert.rejects(stopped.provider.deploy(request, AbortSignal.timeout(1_000), () => {}), /PostgreSQL/);
  const foreign = setup(t); foreign.api.app.configuration!.secrets![0].keyVaultUrl = 'https://other.vault.azure.net/secrets/db-password';
  await assert.rejects(foreign.provider.deploy(request, AbortSignal.timeout(1_000), () => {}), /Key Vault/);
  assert.deepEqual([...stopped.api.actions, ...foreign.api.actions].filter(a => a !== 'identity'), []);
});

test('precheck rejects a digest missing from ACR and multi-arch or non-amd64 images with 400', async t => {
  const { api, provider } = setup(t);
  await assert.doesNotReject(provider.precheck(request));
  for (const value of [undefined, { architecture: 'amd64', operatingSystem: 'linux', multiArch: true }, { architecture: 'arm64', operatingSystem: 'linux', multiArch: false }]) {
    api.manifestValue = value;
    await assert.rejects(provider.precheck(request), { statusCode: 400 });
  }
});

test('stop turns ingress off, deactivates the active revision and confirms the public URL is closed', async t => {
  const { api, provider, fetched } = setup(t);
  await provider.deploy(request, AbortSignal.timeout(5_000), () => {});
  api.actions.length = 0; fetched.length = 0;
  const logs: string[] = [];
  await provider.stop(line => logs.push(line));
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), ['put:closed', 'deactivate']);
  assert.equal(fetched.at(-1), '/:404');
  assert.ok(logs[0].includes('database and Log Analytics retained'));
  // 이미 닫힌 상태에서 다시 불러도 바꾸는 것 없이 성공
  api.actions.length = 0;
  await provider.stop(() => {});
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), []);
});

test('app logs merge the live stream with Log Analytics, deduplicated and oldest first', async t => {
  const { api, provider } = setup(t);
  const lines = await provider.appLogs('dep_test');
  assert.ok(api.queries[0].includes(`RevisionName_s == '${revisionName(config, 'dep_test')}'`));
  assert.deepEqual(lines.map(l => l.line), ['Started BoardApplication', 'Pulling image', 'GET / 200']);
  assert.deepEqual(lines.map(l => l.source), ['app', 'deploy', 'app']);
  api.streamFails = true;
  assert.equal((await provider.appLogs('dep_test')).length, 2);
  assert.equal((await provider.appLogs('dep_test', '2026-10-09T01:00:00.500Z')).length, 1);
});

const arch = (tier: Tier) => ({ version: AZURE_ARCHITECTURE_VERSION, template_id: tier });
// 실제 숫자를 그대로 적는다. 카탈로그에서 읽어 오면 카탈로그가 틀려도 통과한다.
const TIERS = [
  { tier: 'small', cpu: 0.5, memory: '1Gi', min: 1, max: 1, scaling: 'manual' },
  { tier: 'medium', cpu: 1, memory: '2Gi', min: 2, max: 4, scaling: 'automatic 2-4' },
  { tier: 'large', cpu: 2, memory: '4Gi', min: 3, max: 6, scaling: 'automatic 3-6' },
] as const;

test('architecture tiers set CPU, memory, replica range, HTTP scaling and a smaller DB pool', async t => {
  for (const { tier, cpu, memory, min, max, scaling } of TIERS) {
    const { api, provider } = setup(t);
    const planned = requestSchema.parse({ ...request, deployment_id: `dep_${tier}`, architecture: arch(tier), options: { replicas: min } });
    const result = await provider.deploy(planned, AbortSignal.timeout(5_000), () => {});
    const app = api.puts[0], container = app.template!.containers![0];
    assert.deepEqual(container.resources, { cpu, memory });
    assert.equal(app.template!.scale!.minReplicas, min); assert.equal(app.template!.scale!.maxReplicas, max);
    assert.deepEqual(app.template!.scale!.rules, min === max ? [] : [{ name: 'http', http: { metadata: { concurrentRequests: '10' } } }]);
    assert.equal(container.env!.find(e => e.name === 'SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE')?.value, '3');
    assert.equal(result.instances, min);
    // DB 값은 꾸며 낸 문장이 아니라 서버에서 읽은 값이다.
    assert.equal(result.info.architecture, tier); assert.equal(result.info.scaling, scaling);
    assert.equal(result.info.db_availability, 'Disabled'); assert.equal(result.info.db_tier, 'Standard_B1ms');
  }
});

test('a legacy deploy after a planned one resets resources and drops the planned DB pool', async t => {
  const { api, provider } = setup(t);
  api.app.template!.containers![0].resources = { cpu: 2, memory: '4Gi' };
  const result = await provider.deploy(request, AbortSignal.timeout(5_000), () => {});
  const container = api.puts[0].template!.containers![0];
  assert.deepEqual(container.resources, { cpu: 0.5, memory: '1Gi' });
  assert.ok(!container.env!.some(e => e.name === 'SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE'));
  assert.ok(!('db_availability' in result.info));
});

test('readiness accepts more replicas than the start count once autoscaling has added some', async t => {
  const { api, provider } = setup(t);
  api.readyReplicas = 3;
  const planned = requestSchema.parse({ ...request, deployment_id: 'dep_scaled', architecture: arch('medium'), options: { replicas: 2 } });
  const result = await provider.deploy(planned, AbortSignal.timeout(5_000), () => {});
  assert.equal(result.instances, 3);
});

// 범용 HTTP 런타임: 엔진이 project.runtime을 그대로 보낸다. Spring 기본값 대신 앱이 정한 env·바인딩을 쓴다.
const runtime = {
  version: 'http-runtime.v1', port: 8080, health_path: '/healthz', env: { APP_MODE: 'demo' }, secret_refs: { DB_PASSWORD_REF: 'db_password' },
  database: { mode: 'postgres', name: config.dbName, bindings: { DB_HOST: 'host', DB_PORT: 'port', DB_NAME: 'name', DB_USER: 'username', DB_PASS: 'password', JDBC_URL: 'jdbc_url' } },
  init_command: [],
} as const;

test('a generic runtime maps env, PORT, TZ and database bindings; only password-like values become Key Vault secret refs', async t => {
  const { api, provider } = setup(t);
  const planned = requestSchema.parse({ deployment_id: 'dep_rt', project_id: config.projectId, image, port: 8080, health_path: '/healthz', runtime, options: { replicas: 1 } });
  const result = await provider.deploy(planned, AbortSignal.timeout(5_000), () => {});
  const container = api.puts[0].template!.containers![0];
  const env = Object.fromEntries(container.env!.map(e => [e.name, e.value ?? `secretRef:${e.secretRef}`]));
  assert.deepEqual(env, {
    APP_MODE: 'demo', PORT: '8080', TZ: 'UTC',
    DB_HOST: config.dbHost, DB_PORT: '5432', DB_NAME: config.dbName, DB_USER: config.dbUsername,
    JDBC_URL: `jdbc:postgresql://${config.dbHost}:5432/${config.dbName}?sslmode=require`,
    DB_PASS: 'secretRef:db-password', DB_PASSWORD_REF: 'secretRef:db-password',
  });
  assert.ok(!Object.keys(env).some(k => k.startsWith('SPRING_')));
  assert.deepEqual(container.probes![0].httpGet, { path: '/healthz', port: 8080 });
  assert.equal(result.info.session, 'app-defined');
});

test('runtimes this stack cannot serve are rejected before any Azure change', async t => {
  const { api, provider } = setup(t);
  const attempt = (patch: Record<string, unknown>) => {
    const request = requestSchema.parse({ deployment_id: 'dep_bad', project_id: config.projectId, image, port: 8080, health_path: '/', options: { replicas: 1 }, runtime: { ...runtime, ...patch } });
    assert.throws(() => provider.validate(request), (e: Error) => e.message.length > 0);
  };
  attempt({ database: { mode: 'mysql', name: 'app', bindings: { DB_PASS: 'password' } } });                 // PostgreSQL 스택에 MySQL 프로젝트
  attempt({ database: { ...runtime.database, name: 'other_db' } });                                          // 준비된 DB 이름만
  attempt({ database: { ...runtime.database, bindings: { DATABASE_URL: 'postgres_url' } } });               // 이 설정에는 db-url 비밀이 없음
  attempt({ secret_refs: { TOKEN: 'api_token' } });                                                          // 설정 secrets에 등록되지 않은 참조
  attempt({ init_command: ['sh', '-c', 'migrate'] });                                                        // 이 설정에는 initJob이 없음
  assert.ok(!requestSchema.safeParse({ deployment_id: 'dep_bad', project_id: config.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, version: 'other' } }).success);
  assert.deepEqual(api.puts, []);
});

// 다른 엔진 스택: 호스트·URL 비밀·추가 비밀·초기화 작업이 있는 설정
const stack = (engine: 'mysql' | 'mongodb', host: string) => configSchema.parse({ ...config,
  dbEngine: engine, dbHost: host, dbName: 'app', initJob: 'sd-init',
  dbUrlSecretUri: 'https://sd-kv-replace.vault.azure.net/secrets/db-url', secrets: { api_token: 'https://sd-kv-replace.vault.azure.net/secrets/api-token' } });
const mysql = stack('mysql', 'sd-my-replace.mysql.database.azure.com'), mongodb = stack('mongodb', 'sd-mongo-replace.global.mongocluster.cosmos.azure.com');
const deployWith = async (t: Parameters<typeof setup>[0], c: typeof mysql, patch: Record<string, unknown>) => {
  const { api, provider } = setup(t, c);
  const r = requestSchema.parse({ deployment_id: 'dep_eng', project_id: c.projectId, image, port: 8080, health_path: '/', options: { replicas: 1 }, runtime: { ...runtime, ...patch } });
  const result = await provider.deploy(r, AbortSignal.timeout(5_000), () => {});
  const env = Object.fromEntries(api.puts[0].template!.containers![0].env!.map(e => [e.name, e.value ?? `secretRef:${e.secretRef}`]));
  return { api, provider, result, env, secrets: api.puts[0].configuration!.secrets! };
};

test('a MySQL stack maps JDBC and URL bindings; the URL comes from the Key Vault db-url secret the adapter never reads', async t => {
  const { api, result, env, secrets } = await deployWith(t, mysql, { database: { mode: 'mysql', name: 'app', bindings: { DB_HOST: 'host', DB_PORT: 'port', JDBC_URL: 'jdbc_url', DB_PASS: 'password', DATABASE_URL: 'mysql_url' } } });
  assert.deepEqual(env, { APP_MODE: 'demo', PORT: '8080', TZ: 'UTC', DB_HOST: mysql.dbHost, DB_PORT: '3306',
    JDBC_URL: `jdbc:mysql://${mysql.dbHost}:3306/app?sslMode=REQUIRED`, DB_PASS: 'secretRef:db-password', DATABASE_URL: 'secretRef:db-url', DB_PASSWORD_REF: 'secretRef:db-password' });
  assert.deepEqual(secrets.map(s => [s.name, s.keyVaultUrl]), [['db-password', mysql.dbPasswordSecretUri], ['db-url', mysql.dbUrlSecretUri]]);
  assert.equal(result.info.database, 'Azure MySQL Flexible 17');
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), ['put:open']);
});

test('a MongoDB stack serves only the mongodb_url and name bindings', async t => {
  const { env, secrets } = await deployWith(t, mongodb, { database: { mode: 'mongodb', name: 'app', bindings: { MONGODB_URL: 'mongodb_url', DB_NAME: 'name' } }, secret_refs: {} });
  assert.deepEqual(env, { APP_MODE: 'demo', PORT: '8080', TZ: 'UTC', DB_NAME: 'app', MONGODB_URL: 'secretRef:db-url' });
  assert.deepEqual(secrets.map(s => s.name), ['db-password', 'db-url']);
  const provider = new AzureProvider(mongodb, new FakeAzure(), 1);
  for (const bindings of [{ MONGODB_URL: 'mongodb_url', DB_HOST: 'host' }, { MONGODB_URL: 'mongodb_url', DB_PASS: 'password' }]) {
    assert.throws(() => provider.validate(requestSchema.parse({ deployment_id: 'dep_bad', project_id: mongodb.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, secret_refs: {}, database: { mode: 'mongodb', name: 'app', bindings } } })), { statusCode: 400 });
  }
  // PostgreSQL 프로젝트는 MongoDB 스택에 올 수 없다
  assert.throws(() => provider.validate(requestSchema.parse({ deployment_id: 'dep_bad', project_id: mongodb.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, secret_refs: {} } })), /mongodb/);
});

test('an external database uses only registered Key Vault secrets; none reports no database', async t => {
  const external = await deployWith(t, mysql, { database: { mode: 'external', name: 'app', bindings: {} }, secret_refs: { DATABASE_URL: 'api_token' } });
  assert.deepEqual(external.env, { APP_MODE: 'demo', PORT: '8080', TZ: 'UTC', DATABASE_URL: 'secretRef:ref-api-token' });
  assert.deepEqual(external.secrets.map(s => [s.name, s.keyVaultUrl]), [['db-password', mysql.dbPasswordSecretUri], ['ref-api-token', mysql.secrets.api_token]]);
  assert.equal(external.result.info.database, 'external (app-defined)');
  const none = await deployWith(t, mysql, { database: { mode: 'none', name: 'app', bindings: {} }, secret_refs: {} });
  assert.equal(none.result.info.database, 'none');
  assert.deepEqual(none.secrets.map(s => s.name), ['db-password']);
  assert.throws(() => new AzureProvider(mysql, new FakeAzure(), 1).validate(requestSchema.parse({ deployment_id: 'dep_bad', project_id: mysql.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, database: { mode: 'external', name: 'app', bindings: {} }, secret_refs: { X: 'unregistered' } } })), { statusCode: 400 });
});

test('init_command runs once in the Container Apps job with the same image and env before the app changes; a failed run stops the deploy', async t => {
  const { api, provider: again, env } = await deployWith(t, mysql, { database: { mode: 'mysql', name: 'app', bindings: { DB_PASS: 'password', DATABASE_URL: 'mysql_url' } }, init_command: ['node', 'migrate.js', '--up'] });
  // 작업에는 비밀 목록만 넣고, 이미지·명령·환경변수는 이번 실행에만 넘긴다
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), ['put:job', 'start:job', 'put:open']);
  const init = api.jobStarts[0];
  assert.equal(init.image, image); assert.deepEqual(init.command, ['node']); assert.deepEqual(init.args, ['migrate.js', '--up']);
  assert.deepEqual(Object.fromEntries(init.env!.map(e => [e.name, e.value ?? `secretRef:${e.secretRef}`])), env);
  assert.deepEqual(api.jobPuts[0].configuration!.secrets!.map(s => s.name), ['db-password', 'db-url']);
  // 비밀 목록이 같으면 다음 실행은 작업을 다시 갱신하지 않는다
  api.actions.length = 0;
  await again.deploy(requestSchema.parse({ deployment_id: 'dep_eng3', project_id: mysql.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, database: { mode: 'mysql', name: 'app', bindings: { DB_PASS: 'password', DATABASE_URL: 'mysql_url' } }, init_command: ['node', 'migrate.js'] } }), AbortSignal.timeout(5_000), () => {});
  assert.deepEqual(api.actions.filter(a => a !== 'identity'), ['start:job', 'put:open']);
  const failed = new FakeAzure(); failed.jobResult = 'Failed';
  const provider = new AzureProvider(mysql, failed, 1);
  const r = requestSchema.parse({ deployment_id: 'dep_eng2', project_id: mysql.projectId, image, port: 8080, health_path: '/', runtime: { ...runtime, database: { mode: 'mysql', name: 'app', bindings: { DB_PASS: 'password' } }, init_command: ['sh', '-c', 'exit 1'] } });
  await assert.rejects(provider.deploy(r, AbortSignal.timeout(5_000), () => {}), /Failed/);
  assert.deepEqual(failed.puts, []);
});

test('config ties the host suffix to the engine and keeps the stack secret names reserved', () => {
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.ok(!configSchema.safeParse({ ...base, dbEngine: 'mysql' }).success);                                              // postgres 호스트에 mysql
  assert.ok(!configSchema.safeParse({ ...base, dbEngine: 'mongodb', dbHost: 'x.mysql.database.azure.com' }).success);
  assert.ok(configSchema.safeParse({ ...base, dbEngine: 'mongodb', dbHost: 'x.mongocluster.cosmos.azure.com' }).success);
  assert.ok(!configSchema.safeParse({ ...base, secrets: { db_password: base.dbPasswordSecretUri } }).success);
  assert.ok(!configSchema.safeParse({ ...base, secrets: { token: 'https://other.example.com/secrets/x' } }).success);
  // 비밀 이름으로 바꾸면 겹치는 참조(ref-api-token 두 개)는 설정에서 막는다
  assert.ok(!configSchema.safeParse({ ...base, secrets: { API_TOKEN: base.dbPasswordSecretUri, 'api-token': base.dbPasswordSecretUri } }).success);
});
