import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { configSchema, loadConfig, validateRequest } from '../src/config.js';
import { ApiError, requestSchema } from '../src/model.js';

// 설정 파일과 배포 요청의 400 규칙만 본다. GCP는 부르지 않는다.
const prefix = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/';
const raw = {
  gcpProject: 'shakedown-511106', gcpProjectNumber: '700410260240', region: 'asia-northeast3',
  projectId: 'prj_board', serviceName: 'shakedown-board', jobName: 'shakedown-board-schema',
  imagePrefixes: [prefix], network: 'default', subnetwork: 'default',
  dbHost: '10.20.0.3', dbName: 'board_db', dbUsername: 'board', dbPasswordSecret: 'shakedown-db-password',
};
// loadConfig는 파일 경로를 받으므로 임시 폴더에 JSON을 써서 읽힌다.
function load(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shakedown-gcp-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...raw, ...patch }));
    return loadConfig(path);
  } finally { rmSync(dir, { recursive: true }); }
}
const config = configSchema.parse(raw);
const image = prefix + 'shakedown-board@sha256:' + 'a'.repeat(64);
const input = (patch: Record<string, unknown> = {}) => requestSchema.parse({
  deployment_id: 'dep_one', project_id: 'prj_board', image, port: 8080, health_path: '/health',
  env: { SPRING_PROFILES_ACTIVE: 'demo,session-memory' }, secret_refs: { SPRING_DATASOURCE_PASSWORD: 'db_password' },
  database: { engine: 'postgres', name: 'board_db' }, ...patch,
});

test('config port must be a real TCP port', () => {
  for (const port of [0, 70000]) assert.throws(() => load({ port }), z.ZodError);
  assert.equal(load({ port: 9000 }).port, 9000);
});

test('config file fills Cloud Run defaults', () => {
  const loaded = load();
  assert.equal(loaded.port, 8080); assert.equal(loaded.memory, '1Gi'); assert.equal(loaded.cpu, '1');
  assert.deepEqual(loaded.imagePrefixes, [prefix]);
});

test('config rejects unknown keys, other regions and malformed project ids', () => {
  // ZodError로 좁힌다. 오류 종류를 안 보면, 스키마가 지역·프로젝트를 놓쳐도 뒤의 이미지 접두어 검사가 대신 던져서 통과해 버린다.
  for (const patch of [{ profile: 'default' }, { region: 'us-central1' }, { gcpProject: 'Shakedown_511106' }, { serviceName: 'prj_board' }]) {
    assert.throws(() => load(patch), z.ZodError, JSON.stringify(patch));
  }
});

test('image prefixes are Artifact Registry repository paths of this project and region ending in "/"', () => {
  assert.throws(() => load({ imagePrefixes: ['asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown'] }), /must end with "\/"/);
  for (const bad of [
    'asia-northeast3-docker.pkg.dev/shakedown-511106/',
    'asia-northeast3-docker.pkg.dev/shakedown-511106//',
    'asia-northeast3-docker.pkg.dev/other-project-1/shakedown/',
    'us-central1-docker.pkg.dev/shakedown-511106/shakedown/',
    'docker.io/library/',
  ]) assert.throws(() => load({ imagePrefixes: [bad] }), /Artifact Registry repository/, bad);
  assert.throws(() => load({ imagePrefixes: [prefix, 'docker.io/library/'] }), /Artifact Registry repository/);
  const remote = 'asia-northeast3-docker.pkg.dev/shakedown-511106/dockerhub/';
  assert.deepEqual(load({ imagePrefixes: [prefix, remote] }).imagePrefixes, [prefix, remote]);
});

test('database host must be a private address that Direct VPC egress sends into the VPC', () => {
  for (const host of ['10.20.0.3', '172.16.0.5', '172.31.255.1', '192.168.1.10', '100.64.0.2']) assert.equal(load({ dbHost: host }).dbHost, host);
  for (const host of ['8.8.8.8', '172.32.0.1', '10.0.0.300', '100.128.0.1']) assert.throws(() => load({ dbHost: host }), /private IPv4/, host);
});

test('request matching the configured project, port, image, DB, profile and secret is accepted', () => {
  assert.doesNotThrow(() => validateRequest(config, input()));
  assert.doesNotThrow(() => validateRequest(config, input({ env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } })));
  assert.doesNotThrow(() => validateRequest(config, input({ env: {}, secret_refs: {}, database: undefined })));
  assert.doesNotThrow(() => validateRequest(config, input({ options: { replicas: 2, sticky_sessions: true } })));
  const remote = 'asia-northeast3-docker.pkg.dev/shakedown-511106/dockerhub/';
  const twoRepositories = configSchema.parse({ ...raw, imagePrefixes: [prefix, remote] });
  assert.doesNotThrow(() => validateRequest(twoRepositories, input({ image: remote + 'team/board@sha256:' + 'b'.repeat(64) })));
});

test('requests outside the prepared GCP resources are rejected with 400', () => {
  const digest = '@sha256:' + 'a'.repeat(64);
  for (const patch of [
    { project_id: 'prj_other' },
    { port: 9090 },
    { image: prefix + 'shakedown-board:latest' },
    { image: prefix + 'shakedown-board@sha256:' + 'a'.repeat(63) },
    { image: prefix + 'shakedown-board@sha256:' + 'A'.repeat(64) },
    { image: prefix + digest },
    { image: 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown-evil/board' + digest },
    { image: 'docker.io/library/nginx' + digest },
    { database: { engine: 'postgres', name: 'other_db' } },
    { env: { SPRING_DATASOURCE_PASSWORD: 'unsafe' } },
    { env: { SPRING_PROFILES_ACTIVE: 'schema-init' } },
    { env: { SPRING_PROFILES_ACTIVE: 'demo,session-memory', JAVA_TOOL_OPTIONS: '-Xmx64m' } },
    { secret_refs: { SPRING_DATASOURCE_PASSWORD: 'other' } },
    { secret_refs: { OTHER_SECRET: 'db_password' } },
  ]) {
    assert.throws(() => validateRequest(config, input(patch)), (error: unknown) => error instanceof ApiError && error.statusCode === 400, JSON.stringify(patch));
  }
});

// 계획 배포 요청: medium(시작 2대), JDBC 세션 프로필. compute만 적용하므로 설정에 따로 더할 것은 없다.
const medium = { architecture: { version: 'gcp-architecture.v1', template_id: 'medium' }, options: { replicas: 2 }, env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } };

test('a plan request needs the JDBC session profile and no sticky sessions', () => {
  assert.doesNotThrow(() => validateRequest(config, input(medium)));
  for (const [label, patch] of [
    ['memory sessions', { ...medium, env: { SPRING_PROFILES_ACTIVE: 'demo,session-memory' } }],
    ['no profile', { ...medium, env: {} }],
    ['sticky sessions', { ...medium, options: { replicas: 2, sticky_sessions: true } }],
  ] as const) {
    assert.throws(() => validateRequest(config, input(patch)), (error: unknown) => error instanceof ApiError && error.statusCode === 400, label);
  }
});

test('a request without a plan keeps sticky sessions', () => {
  assert.doesNotThrow(() => validateRequest(config, input({ options: { replicas: 2, sticky_sessions: true } })));
});

test('rejection messages never echo plaintext secret values', () => {
  assert.throws(() => validateRequest(config, input({ env: { SPRING_DATASOURCE_PASSWORD: 'unsafe' } })),
    (error: unknown) => error instanceof ApiError && error.message.includes('SPRING_DATASOURCE_PASSWORD') && !error.message.includes('unsafe'));
});

// 범용 런타임(http-runtime.v1): 엔진은 runtime을 보내면 database·secret_refs·env를 빼고 port·health_path를 runtime 값으로 맞춘다.
type Runtime = { port?: number; health_path?: string; env?: Record<string, string>; secret_refs?: Record<string, string>;
  database?: { mode: string; name?: string; bindings?: Record<string, string> }; init_command?: string[] };
const runtime = (patch: Runtime = {}) => ({ version: 'http-runtime.v1', port: 3000, health_path: '/healthz', env: { NODE_ENV: 'production' }, secret_refs: {},
  database: { mode: 'none', name: 'app', bindings: {} }, init_command: [], ...patch });
const postgres = (bindings: Record<string, string> = { DB_URL: 'jdbc_url', DB_USER: 'username', DB_PASSWORD: 'password' }) =>
  ({ database: { mode: 'postgres', name: 'board_db', bindings } });
const runtimeInput = (r: ReturnType<typeof runtime>, patch: Record<string, unknown> = {}) => requestSchema.parse({
  deployment_id: 'dep_rt', project_id: 'prj_board', image, port: r.port, health_path: r.health_path, runtime: r, ...patch,
});
const rejected = (request: ReturnType<typeof runtimeInput>, label: string, message?: RegExp) =>
  assert.throws(() => validateRequest(config, request), (error: unknown) => error instanceof ApiError && error.statusCode === 400 && (!message || message.test(error.message)), label);

test('runtime requests with no DB or the prepared PostgreSQL are accepted on any container port', () => {
  // 옛 방식과 달리 포트는 설정과 같지 않아도 된다(Cloud Run은 리비전마다 containerPort를 정한다).
  assert.doesNotThrow(() => validateRequest(config, runtimeInput(runtime())));
  assert.doesNotThrow(() => validateRequest(config, runtimeInput(runtime({ port: 8080 }))));
  assert.doesNotThrow(() => validateRequest(config, runtimeInput(runtime({ ...postgres(), secret_refs: { APP_DB_PASSWORD: 'db_password' }, init_command: ['npm', 'run', 'migrate'] }))));
  for (const binding of ['host', 'port', 'name', 'username', 'jdbc_url']) {
    assert.doesNotThrow(() => validateRequest(config, runtimeInput(runtime(postgres({ DB_VALUE: binding, DB_PASSWORD: 'password' })))), binding);
  }
});

test('runtime DB modes other than none and postgres are rejected', () => {
  rejected(runtimeInput(runtime({ database: { mode: 'mysql', name: 'board_db', bindings: { DB_PASSWORD: 'password' } } })), 'mysql', /none.*postgres/);
  rejected(runtimeInput(runtime({ database: { mode: 'mongodb', name: 'board_db', bindings: { MONGO_URL: 'mongodb_url' } } })), 'mongodb', /none.*postgres/);
  rejected(runtimeInput(runtime({ database: { mode: 'external', name: 'app', bindings: {} }, secret_refs: { EXTERNAL_DB_URL: 'db_password' } })), 'external', /none.*postgres/);
});

test('runtime requests must not mix in legacy settings', () => {
  const r = runtime(postgres());
  for (const [label, patch] of [
    ['other port', { port: 8080 }],
    ['other health path', { health_path: '/health' }],
    ['legacy database', { database: { engine: 'postgres', name: 'board_db' } }],
    ['legacy env', { env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } }],
    ['legacy secret_refs', { secret_refs: { SPRING_DATASOURCE_PASSWORD: 'db_password' } }],
  ] as const) rejected(runtimeInput(r, patch), label, /섞을 수 없습니다/);
});

test('runtime PostgreSQL must use the prepared DB name, no URL binding and only the db_password secret', () => {
  rejected(runtimeInput(runtime({ database: { mode: 'postgres', name: 'other_db', bindings: { DB_PASSWORD: 'password' } } })), 'db name', /데이터베이스 이름/);
  // URL에는 비밀번호가 들어가는데 어댑터는 Secret Manager 값을 모른다.
  rejected(runtimeInput(runtime(postgres({ DATABASE_URL: 'postgres_url' }))), 'postgres_url', /postgres_url/);
  rejected(runtimeInput(runtime({ ...postgres(), secret_refs: { API_TOKEN: 'app_token' } })), 'other secret', /db_password/);
  rejected(runtimeInput(runtime({ secret_refs: { API_TOKEN: 'app_token' } })), 'other secret without DB', /db_password/);
  // GCP가 줄 수 있는 비밀은 Cloud SQL 비밀번호뿐이다. DB가 없다고 한 앱에는 넣지 않는다(최소 권한).
  rejected(runtimeInput(runtime({ secret_refs: { APP_DB_PASSWORD: 'db_password' } })), 'db_password without DB', /DB 없는/);
});

test('runtime names reserved by Cloud Run are rejected wherever they appear', () => {
  for (const name of ['K_SERVICE', 'K_REVISION', 'K_CONFIGURATION', 'CLOUD_RUN_JOB', 'CLOUD_RUN_EXECUTION', 'CLOUD_RUN_TASK_INDEX',
    'CLOUD_RUN_TASK_ATTEMPT', 'CLOUD_RUN_TASK_COUNT', 'CLOUD_RUN_WORKER_POOL', 'CLOUD_RUN_REVISION', 'X_GOOGLE_FEATURE']) {
    rejected(runtimeInput(runtime({ env: { [name]: 'x' } })), `env ${name}`, new RegExp(name));
    rejected(runtimeInput(runtime({ ...postgres(), secret_refs: { [name]: 'db_password' } })), `secret ${name}`, new RegExp(name));
    rejected(runtimeInput(runtime(postgres({ [name]: 'host', DB_PASSWORD: 'password' }))), `binding ${name}`, new RegExp(name));
  }
});

test('a plan with a runtime needs no Spring profile but still refuses sticky sessions', () => {
  const plan = { architecture: { version: 'gcp-architecture.v1', template_id: 'medium' }, options: { replicas: 2 } };
  assert.doesNotThrow(() => validateRequest(config, runtimeInput(runtime(postgres()), plan)));
  // runtime 앱에는 JDBC 세션이 없을 수 있다. 따라 할 수 없는 해결책(JDBC)을 안내하지 않는다.
  rejected(runtimeInput(runtime(postgres()), { ...plan, options: { replicas: 2, sticky_sessions: true } }), 'sticky', /^(?!.*JDBC).*sticky_sessions/);
});

test('a malformed runtime fails request parsing before validation', () => {
  // 모양 검사는 계약의 validateRuntime(packages/contracts/runtime.mjs)이 한다. PORT·TZ 이름, 비밀 같은 env, init_command와 DB 없음 등.
  for (const bad of [runtime({ env: { PORT: '3000' } }), runtime({ env: { DB_PASSWORD: 'unsafe' } }), runtime({ init_command: ['migrate'] }),
    runtime({ database: { mode: 'postgres', name: 'board_db', bindings: { DB_HOST: 'host' } } })]) {
    assert.throws(() => runtimeInput(bad), z.ZodError, JSON.stringify(bad));
  }
});
