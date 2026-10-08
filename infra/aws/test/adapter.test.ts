import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Manager } from '../src/manager.js';
import { requestSchema, redact, type Provider, type DeployRequest } from '../src/model.js';
import { configSchema, validateRequest } from '../src/config.js';

const image = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shakedown-board@sha256:' + 'a'.repeat(64);
const input = (id = 'dep_one') => requestSchema.parse({ deployment_id: id, project_id: 'prj_board', image, port: 8080, health_path: '/' });
const ready = { url: 'http://demo.ap-northeast-2.elb.amazonaws.com', instances: 2, info: { runtime: 'test double' } };
class Fake implements Provider {
  calls = 0; stops = 0; fail = false; wait = false; stopFails = false;
  validate(_r: DeployRequest) {}
  async deploy(_r: DeployRequest, signal: AbortSignal) {
    this.calls++;
    if (this.wait) await sleep(100_000, undefined, { signal });
    if (this.fail) throw new Error('AWS failure password=unsafe');
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
    assert.equal((await app.inject('/deployments/dep_one')).json().url, ready.url);
    const duplicate = await app.inject({ method: 'POST', url: '/deployments', payload: input() });
    assert.equal(duplicate.statusCode, 202); assert.equal(provider.calls, 1);
    const conflict = await app.inject({ method: 'POST', url: '/deployments', payload: { ...input(), options: { replicas: 2 } } });
    assert.equal(conflict.statusCode, 409);
  } finally { await app.close(); store.close(); }
});

test('active project is locked; DELETE cancels and leaves an unreusable tombstone', async () => {
  const { app, provider, store, manager } = fixture(); provider.wait = true;
  try {
    manager.create(input());
    assert.throws(() => manager.create(input('dep_two')), { statusCode: 409 });
    const response = await app.inject({ method: 'DELETE', url: '/deployments/dep_one' });
    assert.equal(response.statusCode, 204); assert.ok(provider.stops >= 1);
    assert.equal((await app.inject('/deployments/dep_one')).statusCode, 404);
    assert.throws(() => manager.create(input()), { statusCode: 409 });
    assert.equal((await app.inject({ method: 'DELETE', url: '/deployments/dep_one' })).statusCode, 204);
    assert.equal((await app.inject('/deployments/dep_one/logs')).statusCode, 200);
  } finally { await app.close(); store.close(); }
});

test('deleting old history cannot stop the current deployment', async () => {
  const { store, provider, manager, app } = fixture();
  try {
    manager.create(input()); await manager.drain();
    manager.create(input('dep_two')); await manager.drain();
    await manager.remove('dep_one'); assert.equal(provider.stops, 0);
    assert.equal(store.result('dep_two').status, 'ready');
    await manager.remove('dep_two'); assert.equal(provider.stops, 1);
  } finally { await app.close(); store.close(); }
});

test('failed readiness closes service and redacts cause; cleanup failure keeps project locked', async () => {
  const { store, provider, manager, app } = fixture(); provider.fail = true; provider.stopFails = true;
  try {
    manager.create(input()); await manager.drain();
    assert.equal(store.result('dep_one').status, 'failed');
    assert.ok(!store.result('dep_one').error?.includes('unsafe'));
    assert.throws(() => manager.create(input('dep_two')), { statusCode: 409 });
    provider.stopFails = false; await manager.remove('dep_one');
    assert.equal(store.row('dep_one')?.deleted, 1);
  } finally { await app.close(); store.close(); }
});

test('deadline aborts deployment and closes route', async () => {
  const store = new Store(':memory:'); const provider = new Fake(); provider.wait = true;
  const manager = new Manager(store, provider, 10);
  manager.create(input()); await manager.drain();
  assert.equal(store.result('dep_one').status, 'failed'); assert.equal(provider.stops, 1); store.close();
});

test('restart preserves request identity and fails interrupted work closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shakedown-store-')); const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  store.accept(input()); store.log('dep_one', 'started'); store.close();
  store = new Store(path); const provider = new Fake(); const manager = new Manager(store, provider);
  try {
    await manager.recover(); assert.equal(provider.stops, 1);
    assert.equal(store.result('dep_one').status, 'failed');
    assert.equal(manager.create(input()).status, 'failed'); assert.equal(provider.calls, 0);
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
    assert.equal((await app.inject('/health')).json().target, 'aws');
  } finally { await app.close(); store.close(); }
});

test('secrets are filtered from deployment and app logs', async () => {
  const { app, store, manager } = fixture();
  try {
    manager.create(input()); await manager.drain();
    store.log('dep_one', 'password=unsafe Authorization: Bearer unsafe');
    const response = await app.inject('/deployments/dep_one/logs');
    assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('unsafe'));
    assert.equal(redact('jdbc:postgresql://user:unsafe@db:5432/x'), 'jdbc:postgresql://[REDACTED]@db:5432/x');
  } finally { await app.close(); store.close(); }
});

test('AWS request restricts image, project, DB, profiles and plaintext secrets', () => {
  const c = { projectId: 'prj_board', port: 8080, repositoryUri: image.split('@')[0], dbName: 'board_db' } as Parameters<typeof validateRequest>[0];
  assert.doesNotThrow(() => validateRequest(c, input()));
  for (const patch of [{ image: image.split('@')[0] + ':latest' }, { project_id: 'other' }, { env: { SPRING_DATASOURCE_PASSWORD: 'unsafe' } }, { env: { SPRING_PROFILES_ACTIVE: 'schema-init' } }, { secret_refs: { SPRING_DATASOURCE_PASSWORD: 'other' } }, { database: { engine: 'postgres', name: 'other' } }]) {
    assert.throws(() => validateRequest(c, { ...input(), ...patch } as DeployRequest), { statusCode: 400 });
  }
  assert.throws(() => requestSchema.parse({ ...input(), database: { engine: 'mysql', name: 'board_db' } }));
  assert.doesNotThrow(() => requestSchema.parse(input()));
  assert.throws(() => requestSchema.parse({ ...input(), health_path: '//outside.example' }));
  assert.throws(() => requestSchema.parse({ ...input(), options: { sticky_sessions: true } }));
  assert.equal(configSchema.shape.profile.safeParse('default').success, false);
});

test('persisted state cannot be rebound to a different AWS stack', () => {
  const store = new Store(':memory:');
  try {
    store.bindStack('stack-one'); store.bindStack('stack-one');
    assert.throws(() => store.bindStack('stack-two'), /different AWS stack/);
  } finally { store.close(); }
});
