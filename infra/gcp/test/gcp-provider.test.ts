import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { GcpProvider } from '../src/gcp-provider.js';
import { CloudRun, type RunJob, type RunService } from '../src/cloud-run.js';
import { configSchema } from '../src/config.js';
import { requestSchema, type DeployRequest } from '../src/model.js';

const config = configSchema.parse({
  gcpProject: 'shakedown-511106', gcpProjectNumber: '700410260240', region: 'asia-northeast3',
  projectId: 'prj_board', serviceName: 'shakedown-board', jobName: 'shakedown-board-schema',
  imagePrefixes: ['asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/'],
  network: 'default', subnetwork: 'default', dbHost: '10.20.0.3', dbName: 'board_db',
  dbUsername: 'board', dbPasswordSecret: 'shakedown-db-password',
});
const image = config.imagePrefixes[0] + 'board@sha256:' + 'a'.repeat(64);
const OLD_IMAGE = config.imagePrefixes[0] + 'board@sha256:' + 'f'.repeat(64);
const PUBLIC_URL = 'https://shakedown-board-700410260240.asia-northeast3.run.app';
function input(options: Record<string, unknown> = { replicas: 2 }): DeployRequest {
  return requestSchema.parse({ deployment_id: 'dep_test', project_id: config.projectId, image, port: 8080, health_path: '/health', options,
    env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' }, secret_refs: { SPRING_DATASOURCE_PASSWORD: 'db_password' } });
}

// 실제 CloudRun을 상속해 GCP 호출만 가로챈다. 호출 순서를 actions에 남기고, 넣은 서비스를 "준비 완료" 상태로 돌려준다.
class FakeRun extends CloudRun {
  actions: string[] = [];
  jobs: RunJob[] = [];
  services: RunService[] = [];
  current: RunService | undefined = { template: { containers: [{ image: OLD_IMAGE }] } };  // 이미 있는 서비스
  readyImage: string | undefined;  // 정해 두면 준비된 서비스의 image를 이 값으로 돌려준다(옛 digest 흉내)
  readyPatch: Partial<RunService> = {};  // 준비 완료 상태의 일부 칸을 덮어써 "아직 준비 안 됨"을 흉내 낸다
  jobError: Error | undefined;
  constructor() { super(async () => { throw new Error('real HTTP is not allowed in tests'); }, config); }
  override async getService() { this.actions.push('getService'); return this.current; }
  override async setPublic(open: boolean) { this.actions.push(`setPublic:${open}`); }
  override async runSchemaJob(job: RunJob) { this.actions.push('runSchemaJob'); this.jobs.push(job); if (this.jobError) throw this.jobError; }
  override async putService(service: RunService) {
    this.actions.push('putService'); this.services.push(service);
    const containers = this.readyImage ? [{ ...service.template.containers[0], image: this.readyImage }] : service.template.containers;
    const revision = 'projects/shakedown-511106/locations/asia-northeast3/services/shakedown-board/revisions/shakedown-board-00002-abc';
    this.current = { ...service, template: { ...service.template, containers }, generation: '2', observedGeneration: '2', reconciling: false,
      latestCreatedRevision: revision, latestReadyRevision: revision, terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, ...this.readyPatch };
  }
}
// statuses: 공개 주소 요청이 차례로 받을 상태 코드. 마지막 값은 계속 되풀이한다.
function setup(...statuses: number[]) {
  const run = new FakeRun();
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    run.actions.push('fetch');
    const status = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? 200);
    return new Response(null, { status });
  };
  return { run, requests, provider: new GcpProvider(config, run, fetchFn) };
}

test('deploy grants access, runs schema-init, updates the service, waits for ready and public health in that order', async () => {
  const { run, requests, provider } = setup();
  const result = await provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  assert.deepEqual(run.actions, ['getService', 'setPublic:true', 'runSchemaJob', 'putService', 'getService', 'fetch']);
  assert.equal(requests[0].url, PUBLIC_URL + '/health');
  assert.equal(requests[0].init?.redirect, 'manual');
  assert.ok(!new Headers(requests[0].init?.headers).has('cookie'));
  assert.deepEqual(result, { url: PUBLIC_URL, instances: 2, info: {
    runtime: 'Cloud Run', region: 'asia-northeast3', database: 'Cloud SQL PostgreSQL', session: 'jdbc', sticky_sessions: 'false',
    image_digest: 'sha256:' + 'a'.repeat(64), revision: 'shakedown-board-00002-abc', scaling: 'manual',
  } });
});

test('first deploy creates the service before granting public access', async () => {
  const { run, provider } = setup(); run.current = undefined;
  await provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  assert.deepEqual(run.actions.slice(0, 4), ['getService', 'runSchemaJob', 'putService', 'setPublic:true']);
});

test('service template uses manual scaling, VPC egress, container port and a secret reference instead of a plain password', async () => {
  const { run, provider } = setup();
  await provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  const service = run.services[0];
  const container = service.template.containers[0];
  assert.equal(container.image, image);
  assert.deepEqual(container.ports, [{ containerPort: 8080 }]);
  assert.deepEqual(container.resources, { limits: { memory: '1Gi', cpu: '1' }, cpuIdle: true });
  assert.deepEqual(service.template.vpcAccess, { networkInterfaces: [{ network: 'default', subnetwork: 'default' }], egress: 'PRIVATE_RANGES_ONLY' });
  assert.deepEqual(service.scaling, { scalingMode: 'MANUAL', manualInstanceCount: 2 });
  assert.equal(service.template.sessionAffinity, false);
  assert.equal(service.invokerIamDisabled, false);
  const env = Object.fromEntries((container.env ?? []).map(e => [e.name, e]));
  // 배포마다 리비전 이름을 정해 둬야 그 배포의 앱 로그만 골라 읽을 수 있다(서비스 이름으로 시작, 63자 이하).
  assert.equal(service.template.revision, 'shakedown-board-' + createHash('sha256').update('dep_test').digest('hex').slice(0, 12));
  assert.equal(env.SPRING_DATASOURCE_URL.value, 'jdbc:postgresql://10.20.0.3:5432/board_db');
  assert.equal(env.SPRING_DATASOURCE_USERNAME.value, 'board');
  assert.equal(env.SPRING_JPA_HIBERNATE_DDL_AUTO.value, 'validate');
  assert.equal(env.SPRING_PROFILES_ACTIVE.value, 'demo,session-jdbc');
  assert.equal(env.TZ.value, 'UTC');
  assert.equal(env.PORT, undefined);
  assert.deepEqual(env.SPRING_DATASOURCE_PASSWORD, { name: 'SPRING_DATASOURCE_PASSWORD', valueSource: { secretKeyRef: { secret: 'shakedown-db-password', version: 'latest' } } });
  assert.ok(!(container.env ?? []).some(e => e.name.includes('PASSWORD') && e.value !== undefined));
});

test('schema job runs the same image with schema-init profile, ddl update and no retries', async () => {
  const { run, provider } = setup();
  await provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  const task = run.jobs[0].template.template;
  assert.equal(task.containers[0].image, image);
  assert.equal(task.maxRetries, 0);
  assert.deepEqual(task.vpcAccess, run.services[0].template.vpcAccess);
  const env = Object.fromEntries((task.containers[0].env ?? []).map(e => [e.name, e]));
  assert.equal(env.SPRING_PROFILES_ACTIVE.value, 'schema-init');
  assert.equal(env.SPRING_JPA_HIBERNATE_DDL_AUTO.value, 'update');
  assert.equal(env.SPRING_DATASOURCE_PASSWORD.value, undefined);
  assert.equal(env.SPRING_DATASOURCE_PASSWORD.valueSource?.secretKeyRef.secret, 'shakedown-db-password');
});

test('sticky_sessions=true turns on session affinity', async () => {
  const { run, provider } = setup();
  const result = await provider.deploy(input({ replicas: 2, sticky_sessions: true }), AbortSignal.timeout(2_000), () => {});
  assert.equal(run.services[0].template.sessionAffinity, true);
  assert.equal(result.info.sticky_sessions, 'true');
});

test('a failed schema job stops before the service is touched', async () => {
  const { run, provider } = setup(); run.jobError = new Error('schema-init job failed: exec-1');
  await assert.rejects(provider.deploy(input(), AbortSignal.timeout(2_000), () => {}), /schema-init job failed/);
  assert.ok(!run.actions.includes('putService'));
});

test('an old image digest never becomes ready or gets a health check', async () => {
  const { run, provider } = setup(); run.readyImage = OLD_IMAGE;
  await assert.rejects(provider.deploy(input(), AbortSignal.timeout(50), () => {}));
  assert.ok(!run.actions.includes('fetch'));
});

test('a rollout still reconciling, serving an older revision or behind the latest generation never becomes ready', async () => {
  const older = 'projects/shakedown-511106/locations/asia-northeast3/services/shakedown-board/revisions/shakedown-board-00001-old';
  // 준비 조건 세 칸을 하나씩만 어긋나게 한다. 어느 조건이 빠져도 해당 경우가 health 확인까지 가서 이 테스트가 깨진다.
  for (const patch of [{ reconciling: true }, { latestReadyRevision: older }, { observedGeneration: '1' }]) {
    const { run, provider } = setup(); run.readyPatch = patch;
    await assert.rejects(provider.deploy(input(), AbortSignal.timeout(50), () => {}), JSON.stringify(patch));
    assert.ok(!run.actions.includes('fetch'), JSON.stringify(patch));
  }
});

test('a failed Cloud Run rollout fails fast with its message', async () => {
  const { run, provider } = setup();
  run.putService = async () => {
    run.actions.push('putService');
    run.current = { template: { containers: [{ image }] }, reconciling: false, terminalCondition: { type: 'Ready', state: 'CONDITION_FAILED', message: 'container failed to start' } };
  };
  await assert.rejects(provider.deploy(input(), AbortSignal.timeout(2_000), () => {}), /container failed to start/);
});

test('HTTP 302 from the health path is not success', async () => {
  const { run, provider } = setup(302);
  await assert.rejects(provider.deploy(input(), AbortSignal.timeout(50), () => {}));
  assert.ok(run.actions.includes('fetch'));
});

test('HTTP 500 from the health path is not success', async () => {
  const { run, provider } = setup(500);
  await assert.rejects(provider.deploy(input(), AbortSignal.timeout(50), () => {}));
  assert.ok(run.actions.includes('fetch'));
});
