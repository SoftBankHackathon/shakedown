import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { architectures, AZURE_ARCHITECTURE_VERSION, PLANNED_POOL_SIZE, shapeOf } from '../src/architecture.js';
import { requestSchema } from '../src/model.js';

// 계획 배포 요청의 모양만 본다. 클라이언트는 버전과 등급 이름만 보내고, CPU·메모리·대수는 서버 카탈로그가 정한다.
const image = 'sdacrreplace.azurecr.io/shakedown-board@sha256:' + 'a'.repeat(64);
const base = { deployment_id: 'dep_plan', project_id: 'prj_board', image, port: 8080, health_path: '/', env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } };
const plan = (template_id: string, options: Record<string, unknown>, version: string = AZURE_ARCHITECTURE_VERSION) => ({ ...base, architecture: { version, template_id }, options });

test('a plan request names the Azure catalog version and a tier, with replicas equal to the tier start count', () => {
  assert.equal(AZURE_ARCHITECTURE_VERSION, 'azure-architecture.v1');
  for (const [tier, spec] of Object.entries(architectures)) {
    const parsed = requestSchema.parse(plan(tier, { replicas: spec.min }));
    assert.deepEqual(parsed.architecture, { version: 'azure-architecture.v1', template_id: tier });
    assert.equal(shapeOf(parsed), spec);
  }
});

test('plan requests outside the catalog are rejected', () => {
  for (const bad of [
    plan('large', { replicas: 3 }, 'aws-architecture.v1'),                                        // 다른 클라우드 카탈로그
    plan('large', { replicas: 3 }, 'gcp-architecture.v1'),
    { ...base, architecture: { version: AZURE_ARCHITECTURE_VERSION, template_id: 'large', cpu: '8' }, options: { replicas: 3 } }, // 사양을 직접 보냄
    plan('huge', { replicas: 3 }),
    plan('medium', { replicas: 3 }),                                                              // 등급 시작 대수와 다름
    plan('small', { replicas: 2 }),
    { ...base, options: { replicas: 3 } },                                                        // 계획 없이 3대
  ]) assert.throws(() => requestSchema.parse(bad), z.ZodError, JSON.stringify(bad));
});

test('a request without a plan parses exactly as before and keeps a fixed replica count', () => {
  const parsed = requestSchema.parse({ ...base, options: { replicas: 2, sticky_sessions: true } });
  assert.deepEqual(parsed, { ...base, secret_refs: {}, options: { replicas: 2, sticky_sessions: true, tz: 'UTC' } });
  assert.deepEqual(shapeOf(parsed), { cpu: 0.5, memory: '1Gi', min: 2, max: 2, scaling: 'MANUAL' });
});

// PostgreSQL B1ms: max_connections 50, superuser_reserved_connections 10 (2026-10-10 조회). 롤아웃 중에는 두 리비전이 같이 붙는다.
const CONNECTION_LIMIT = 50 - 10, ROLLOUT_REVISIONS = 2;
test('every tier fits the B1ms connection limit while two revisions overlap', () => {
  for (const [tier, spec] of Object.entries(architectures)) {
    assert.ok(spec.max * Number(PLANNED_POOL_SIZE) * ROLLOUT_REVISIONS <= CONNECTION_LIMIT, tier);
    assert.ok(spec.min <= spec.max && (spec.scaling === 'MANUAL') === (spec.min === spec.max), tier);
  }
});
