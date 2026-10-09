import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Manager } from '../src/manager.js';
import { requestSchema, redact, ApiError, type Provider, type DeployRequest } from '../src/model.js';
import { configSchema, validateRequest } from '../src/config.js';

const config = configSchema.parse(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
const image = config.repositoryUri + '@sha256:' + 'a'.repeat(64);
const input = (id = 'dep_one') => requestSchema.parse({ deployment_id: id, project_id: 'prj_board', image, port: 8080, health_path: '/' });
const ready = { url: config.publicUrl, instances: 2, info: { runtime: 'test double' } };
class Fake implements Provider {
  calls = 0; stops = 0; fail = false; wait = false; stopFails = false; missing = false;
  validate(_r: DeployRequest) {}
  async precheck(_r: DeployRequest) { if (this.missing) throw new ApiError(400, 'ACR에 해당 digest 이미지가 없습니다.'); }
  async deploy(_r: DeployRequest, signal: AbortSignal) {
    this.calls++;
    if (this.wait) await sleep(100_000, undefined, { signal });
    if (this.fail) throw new Error('Azure failure password=unsafe');
    return ready;
  }
  async stop() { this.stops++; if (this.stopFails) throw new Error('cleanup failed'); }
  async appLogs() { return [{ ts: new Date().toISOString(), source: 'app' as const, line: 'Cookie: SESSION=unsafe' }]; }
}
function fixture() { const store = new Store(':memory:'); const provider = new Fake(); const manager = new Manager(store, provider); return { store, provider, manager, app: buildApp(manager) }; }

test('202 async API, ready, durable idempotency and changed request conflict', async () => {
  const { app, provider, store, manager } = fixture();
  try {
    const first = await app.inject({ method: 'POST', url: '/deployments', payload: input() });
    assert.equal(first.statusCode, 202); assert.equal(first.json().status, 'pending');
    await manager.drain();
    const result = (await app.inject('/deployments/dep_one')).json();
    assert.equal(result.url, ready.url); assert.equal(result.target, 'azure');
    const duplicate = await app.inject({ method: 'POST', url: '/deployments', payload: input() });
    assert.equal(duplicate.statusCode, 202); assert.equal(provider.calls, 1);
    const conflict = await app.inject({ method: 'POST', url: '/deployments', payload: { ...input(), options: { replicas: 2 } } });
    assert.equal(conflict.statusCode, 409);
  } finally { await app.close(); store.close(); }
});

test('image missing from ACR is rejected with 400 before anything is recorded', async () => {
  const { app, provider, store } = fixture(); provider.missing = true;
  try {
    const response = await app.inject({ method: 'POST', url: '/deployments', payload: input() });
    assert.equal(response.statusCode, 400); assert.equal(provider.calls, 0);
    assert.equal(store.row('dep_one'), undefined);
  } finally { await app.close(); store.close(); }
});

test('active project is locked; DELETE cancels and leaves an unreusable tombstone', async () => {
  const { app, provider, store, manager } = fixture(); provider.wait = true;
  try {
    await manager.create(input());
    await assert.rejects(manager.create(input('dep_two')), { statusCode: 409 });
    const response = await app.inject({ method: 'DELETE', url: '/deployments/dep_one' });
    assert.equal(response.statusCode, 204); assert.ok(provider.stops >= 1);
    assert.equal((await app.inject('/deployments/dep_one')).statusCode, 404);
    await assert.rejects(manager.create(input()), { statusCode: 409 });
    assert.equal((await app.inject({ method: 'DELETE', url: '/deployments/dep_one' })).statusCode, 204);
    assert.equal((await app.inject('/deployments/dep_one/logs')).statusCode, 200);
  } finally { await app.close(); store.close(); }
});

test('deleting old history cannot stop the current deployment', async () => {
  const { store, provider, manager, app } = fixture();
  try {
    await manager.create(input()); await manager.drain();
    await manager.create(input('dep_two')); await manager.drain();
    await manager.remove('dep_one'); assert.equal(provider.stops, 0);
    assert.equal(store.result('dep_two').status, 'ready');
    await manager.remove('dep_two'); assert.equal(provider.stops, 1);
  } finally { await app.close(); store.close(); }
});

test('failed readiness closes service and redacts cause; cleanup failure keeps project locked', async () => {
  const { store, provider, manager, app } = fixture(); provider.fail = true; provider.stopFails = true;
  try {
    await manager.create(input()); await manager.drain();
    assert.equal(store.result('dep_one').status, 'failed');
    assert.ok(!store.result('dep_one').error?.includes('unsafe'));
    await assert.rejects(manager.create(input('dep_two')), { statusCode: 409 });
    provider.stopFails = false; await manager.remove('dep_one');
    assert.equal(store.row('dep_one')?.deleted, 1);
  } finally { await app.close(); store.close(); }
});

test('deadline aborts deployment and closes route', async () => {
  const store = new Store(':memory:'); const provider = new Fake(); provider.wait = true;
  const manager = new Manager(store, provider, 10);
  await manager.create(input()); await manager.drain();
  assert.equal(store.result('dep_one').status, 'failed'); assert.equal(provider.stops, 1); store.close();
});

test('restart preserves request identity and fails interrupted work closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shakedown-azure-store-')); const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  store.accept(input()); store.log('dep_one', 'started'); store.close();
  store = new Store(path); const provider = new Fake(); const manager = new Manager(store, provider);
  try {
    await manager.recover(); assert.equal(provider.stops, 1);
    assert.equal(store.result('dep_one').status, 'failed');
    assert.equal((await manager.create(input())).status, 'failed'); assert.equal(provider.calls, 0);
    assert.ok(store.logs('dep_one').length >= 2);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('loopback API rejects browser origin, foreign host, invalid input and invalid since', async () => {
  const { app, store } = fixture();
  try {
    assert.equal((await app.inject({ url: '/health', headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/health', headers: { host: 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/deployments', payload: { ...input(), options: { replicas: 3 } } })).statusCode, 400);
    assert.equal((await app.inject('/deployments/dep_one/logs?since=nope')).statusCode, 400);
    assert.deepEqual((await app.inject('/health')).json(), { ok: true, target: 'azure' });
  } finally { await app.close(); store.close(); }
});

test('secrets are filtered from deployment and app logs', async () => {
  const { app, store, manager } = fixture();
  try {
    await manager.create(input()); await manager.drain();
    store.log('dep_one', 'password=unsafe Authorization: Bearer unsafe');
    const response = await app.inject('/deployments/dep_one/logs');
    assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('unsafe'));
    assert.equal(redact('jdbc:postgresql://user:unsafe@db:5432/x'), 'jdbc:postgresql://[REDACTED]@db:5432/x');
  } finally { await app.close(); store.close(); }
});

test('Azure request restricts image, project, port, DB, profiles and plaintext secrets', () => {
  assert.doesNotThrow(() => validateRequest(config, input()));
  assert.doesNotThrow(() => validateRequest(config, requestSchema.parse({ ...input(), options: { replicas: 2, sticky_sessions: true }, env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' }, secret_refs: { SPRING_DATASOURCE_PASSWORD: 'db_password' }, database: { engine: 'postgres', name: 'board_db' } })));
  for (const patch of [
    { image: config.repositoryUri + ':latest' }, { image: 'otheracr.azurecr.io/shakedown-board@sha256:' + 'a'.repeat(64) },
    { project_id: 'other' }, { port: 9090 },
    { env: { SPRING_DATASOURCE_PASSWORD: 'unsafe' } }, { env: { SPRING_DATASOURCE_URL: 'jdbc:postgresql://evil/x' } }, { env: { SPRING_PROFILES_ACTIVE: 'schema-init' } },
    { secret_refs: { SPRING_DATASOURCE_PASSWORD: 'other' } }, { database: { engine: 'postgres', name: 'other' } },
  ]) {
    assert.throws(() => validateRequest(config, { ...input(), ...patch } as DeployRequest), { statusCode: 400 }, JSON.stringify(patch));
  }
  assert.throws(() => requestSchema.parse({ ...input(), database: { engine: 'mysql', name: 'board_db' } }));
  assert.throws(() => requestSchema.parse({ ...input(), health_path: '//outside.example' }));
  assert.equal(requestSchema.parse({ ...input(), options: { sticky_sessions: true } }).options.sticky_sessions, true);
});

test('config only accepts an https Container Apps URL, Azure PostgreSQL host and Key Vault secret URI', () => {
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(configSchema.safeParse({ ...raw, publicUrl: 'http://sd-app.replace.koreacentral.azurecontainerapps.io' }).success, false);
  assert.equal(configSchema.safeParse({ ...raw, publicUrl: 'https://evil.example' }).success, false);
  assert.equal(configSchema.safeParse({ ...raw, dbHost: 'db.example.com' }).success, false);
  assert.equal(configSchema.safeParse({ ...raw, dbPasswordSecretUri: 'https://evil.example/secrets/x' }).success, false);
  assert.equal(configSchema.safeParse({ ...raw, extra: 1 }).success, false);
});

test('persisted state cannot be rebound to a different Azure stack', () => {
  const store = new Store(':memory:');
  try {
    store.bindStack('stack-one'); store.bindStack('stack-one');
    assert.throws(() => store.bindStack('stack-two'), /different Azure stack/);
  } finally { store.close(); }
});
