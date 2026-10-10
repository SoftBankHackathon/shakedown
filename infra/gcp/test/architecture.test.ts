import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { architectures, GCP_ARCHITECTURE_VERSION } from '../src/architecture.js';
import { requestSchema } from '../src/model.js';

// 계획 배포 요청의 모양만 본다. 클라이언트는 버전과 등급 이름만 보내고, CPU·메모리·대수는 서버 카탈로그가 정한다.
const image = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/kty-board@sha256:' + 'a'.repeat(64);
const base = { deployment_id: 'dep_plan', project_id: 'prj_board', image, port: 8080, health_path: '/health', env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } };
const plan = (template_id: string, options: Record<string, unknown>, version: string = GCP_ARCHITECTURE_VERSION) => ({ ...base, architecture: { version, template_id }, options });

test('a plan request names the GCP catalog version and a tier, with replicas equal to the tier minimum', () => {
  assert.equal(GCP_ARCHITECTURE_VERSION, 'gcp-architecture.v1');
  for (const [tier, spec] of Object.entries(architectures)) {
    const parsed = requestSchema.parse(plan(tier, { replicas: spec.min }));
    assert.deepEqual(parsed.architecture, { version: 'gcp-architecture.v1', template_id: tier });
    assert.equal(parsed.options.replicas, spec.min);
  }
});

test('plan requests outside the catalog are rejected', () => {
  for (const bad of [
    plan('large', { replicas: 3 }, 'aws-architecture.v1'),                                       // 다른 클라우드 카탈로그
    { ...base, architecture: { version: GCP_ARCHITECTURE_VERSION, template_id: 'large', cpu: '8' }, options: { replicas: 3 } }, // 사양을 직접 보냄
    plan('xlarge', { replicas: 3 }),
    plan('large', { replicas: 2 }),                                                              // 등급 최소 대수와 다름
    plan('small', { replicas: 2 }),
    { ...base, options: { replicas: 3 } },                                                       // 계획 없이 3대
  ]) assert.throws(() => requestSchema.parse(bad), z.ZodError, JSON.stringify(bad));
});

test('a request without a plan parses exactly as before', () => {
  assert.deepEqual(requestSchema.parse({ ...base, options: { replicas: 2, sticky_sessions: true } }), {
    ...base, secret_refs: {}, options: { replicas: 2, sticky_sessions: true, tz: 'UTC' },
  });
  assert.deepEqual(requestSchema.parse(base), { ...base, secret_refs: {}, options: { replicas: 1, sticky_sessions: false, tz: 'UTC' } });
});

// 2026-10-09 Service Usage 조회값(asia-northeast3): run.googleapis.com/cpu_allocation 20 vCPU, mem_allocation 40 GiB.
// Cloud Run 서비스 최대 인스턴스는 "쿼터 ÷ 인스턴스 사양"까지라, 카탈로그 최대치가 이 안에 들어야 실제로 그만큼 뜬다.
// schema-init Job(1 vCPU / 1 GiB)이 같은 쿼터를 함께 쓰고, 롤아웃 중에는 새 인스턴스가 옛 인스턴스와 겹친다.
// 최대 대수에 Job과 새 인스턴스 1대 몫을 더해 본다. 무료 체험 계정은 쿼터 상향을 요청할 수 없다.
const CPU_QUOTA = 20, MEMORY_QUOTA_GIB = 40, JOB_CPU = 1, JOB_MEMORY_GIB = 1;
test('every tier fits the regional Cloud Run CPU and memory quota together with the schema job and one rollout instance', () => {
  for (const [tier, spec] of Object.entries(architectures)) {
    const memoryGiB = Number(spec.memory.replace(/Gi$/, ''));
    assert.ok((spec.max + 1) * Number(spec.cpu) + JOB_CPU <= CPU_QUOTA, `${tier} cpu`);
    assert.ok((spec.max + 1) * memoryGiB + JOB_MEMORY_GIB <= MEMORY_QUOTA_GIB, `${tier} memory`);
    assert.ok(spec.min <= spec.max, tier);
  }
});

// 지금 Cloud SQL(db-f1-micro, ZONAL)의 max_connections는 25이고 관리용 예약 몇 개를 빼면 앱 몫은 약 22개다.
// 자동 확장으로 최대 대수까지 늘어도 연결이 넘치지 않게 "최대 대수 × 인스턴스당 풀"을 20 이하로 둔다.
// small은 풀을 정하지 않는다(앱 기본값 10). 1대뿐이라 10개면 충분히 안에 든다.
const APP_CONNECTIONS = 20, SPRING_DEFAULT_POOL = 10;
test('every tier keeps max instances times the per-instance pool within the shared-core DB connection budget', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(architectures).map(([tier, spec]) => [tier, spec.pool])), { small: undefined, medium: 5, large: 2 });
  for (const [tier, spec] of Object.entries(architectures)) {
    assert.ok(spec.max * (spec.pool ?? SPRING_DEFAULT_POOL) <= APP_CONNECTIONS, tier);
  }
});
