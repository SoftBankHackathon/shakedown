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

test('rejection messages never echo plaintext secret values', () => {
  assert.throws(() => validateRequest(config, input({ env: { SPRING_DATASOURCE_PASSWORD: 'unsafe' } })),
    (error: unknown) => error instanceof ApiError && error.message.includes('SPRING_DATASOURCE_PASSWORD') && !error.message.includes('unsafe'));
});
