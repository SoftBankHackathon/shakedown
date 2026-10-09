import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ContainerApp, Revision } from '@azure/arm-appcontainers';
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
  manifestValue: Manifest | undefined = { architecture: 'amd64', operatingSystem: 'linux', multiArch: false };
  app: Mutable<ContainerApp> = { location: 'koreacentral', configuration: { secrets: [{ name: 'db-password', keyVaultUrl: config.dbPasswordSecretUri, identity: '/identity' }] }, template: { containers: [{ name: 'app', image: 'old', resources: { cpu: 0.5, memory: '1Gi' } }] } };
  revisions = new Map<string, Mutable<Revision> & { polls: number }>();
  revisionImage?: string; neverReady = false; streamFails = false;
  async identity() { this.actions.push('identity'); return this.identityValue; }
  async databaseState() { return { state: this.dbState, highAvailability: 'Disabled', tier: 'Standard_B1ms' }; }
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
function setup(t: { mock: { method: Function } }) {
  const api = new FakeAzure(); const provider = new AzureProvider(config, api, 1);
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
  assert.ok(logs[0].includes('PostgreSQL and Log Analytics retained'));
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
