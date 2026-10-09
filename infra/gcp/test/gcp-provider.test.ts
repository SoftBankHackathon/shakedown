import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { GcpProvider } from '../src/gcp-provider.js';
import { CloudRun, type RunJob, type RunService } from '../src/cloud-run.js';
import { architectures, type Tier } from '../src/architecture.js';
import { configSchema } from '../src/config.js';
import { GcpError } from '../src/gcp-http.js';
import { Manager } from '../src/manager.js';
import { requestSchema, type DeployRequest, type LogLine } from '../src/model.js';
import { Store } from '../src/store.js';

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
  instances: number[] = [];
  revoke: Promise<void> = Promise.resolve();  // setPublic(false)를 이 약속이 풀릴 때까지 붙잡는다
  revokeError: Error | undefined;
  logLines: LogLine[] = [];
  logError: Error | undefined;
  since: string | undefined;
  revision: string | undefined;
  clearedAutomatic: boolean[] = [];
  scaleError: Error | undefined;
  override async setInstances(count: number, _signal: AbortSignal, clearAutomatic = false) { this.actions.push(`setInstances:${count}`); this.instances.push(count); this.clearedAutomatic.push(clearAutomatic); if (this.scaleError) throw this.scaleError; }
  override async readLogs(revision: string, since: string | undefined) { this.revision = revision; this.since = since; if (this.logError) throw this.logError; return this.logLines; }
  project = { name: 'projects/700410260240', projectId: 'shakedown-511106' };
  override async getProject() { return this.project; }
  override async getService() { this.actions.push('getService'); return this.current; }
  override async setPublic(open: boolean) {
    this.actions.push(`setPublic:${open}`);
    if (!open) { await this.revoke; if (this.revokeError) throw this.revokeError; }
  }
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
    // AWS·Azure 어댑터와 같은 키: 계획이 없으면 legacy.
    architecture: 'legacy',
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
  // 배포마다 리비전 이름을 정해 둬야 그 배포의 앱 로그만 골라 읽을 수 있다(서비스 이름으로 시작, 63자 이하).
  assert.equal(service.template.revision, 'shakedown-board-' + createHash('sha256').update('dep_test').digest('hex').slice(0, 12));
  const env = Object.fromEntries((container.env ?? []).map(e => [e.name, e]));
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

test('verifyProject accepts the configured project and rejects a different one', async () => {
  const { run, provider } = setup();
  await provider.verifyProject();
  run.project = { name: 'projects/700410260240', projectId: 'other-project-1' };
  await assert.rejects(provider.verifyProject(), /프로젝트 ID와 번호/);
  run.project = { name: 'projects/111111111111', projectId: 'shakedown-511106' };
  await assert.rejects(provider.verifyProject(), /프로젝트 ID와 번호/);
});

const settle = () => new Promise(resolve => setImmediate(resolve));

test('stop sets 0 instances, confirms the public URL stops answering, then revokes access without waiting for it', async () => {
  const { run, requests, provider } = setup(200, 503);
  let release!: () => void; run.revoke = new Promise(resolve => { release = resolve; });
  const lines: string[] = [];
  await provider.stop(line => lines.push(line));
  await settle();
  assert.deepEqual(run.actions, ['getService', 'setInstances:0', 'fetch', 'fetch', 'setPublic:false']);
  assert.equal(requests[0].url, PUBLIC_URL);
  assert.equal(requests[0].init?.redirect, 'manual');
  assert.ok(!lines.some(l => l.includes('revoked')));
  release(); await settle();
  assert.ok(lines.includes('public access revoked: allUsers removed'));
});

test('stop fails when the public URL keeps answering 2xx/3xx, and still revokes access', async () => {
  const { run, provider } = setup(302); provider.stopWaitMs = 50;
  await assert.rejects(provider.stop(() => {}), /닫히지 않았습니다/);
  await settle();
  assert.ok(run.actions.includes('setPublic:false'));
});

test('a failed access revoke is logged instead of thrown', async () => {
  const { run, provider } = setup(503); run.revokeError = new Error('IAM denied');
  const lines: string[] = [];
  await provider.stop(line => lines.push(line));
  await settle();
  assert.ok(lines.includes('public access revoke failed: IAM denied'));
});

test('settled waits until the background access revoke has finished', async () => {
  const { run, provider } = setup(503);
  let release!: () => void; run.revoke = new Promise(resolve => { release = resolve; });
  await provider.stop(() => {});
  let done = false;
  const waiting = provider.settled().then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  release(); await waiting;
  assert.equal(done, true);
});

test('stop does nothing when the service does not exist', async () => {
  const { run, provider } = setup(); run.current = undefined;
  await provider.stop(() => {});
  assert.deepEqual(run.actions, ['getService']);
});

test('a deploy right after stop waits until the access revoke has finished', async () => {
  const { run, provider } = setup(503, 200);
  let release!: () => void; run.revoke = new Promise(resolve => { release = resolve; });
  await provider.stop(() => {});
  await settle();
  const mark = run.actions.length;
  const deploying = provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  await settle();
  assert.equal(run.actions.length, mark);
  release();
  await deploying;
  assert.deepEqual(run.actions.slice(mark, mark + 2), ['getService', 'setPublic:true']);
});

test('appLogs returns Cloud Logging lines and hides only the read quota error', async () => {
  const { run, provider } = setup();
  run.logLines = [{ ts: '2026-10-09T00:00:01.000Z', source: 'app', line: 'started' }];
  assert.deepEqual(await provider.appLogs('dep_test', '2026-10-09T00:00:00.000Z'), run.logLines);
  assert.equal(run.since, '2026-10-09T00:00:00.000Z');
  // 서비스 전체가 아니라 그 배포가 만든 리비전의 로그만 읽는다(이전·다음 배포 로그가 섞이지 않게).
  assert.equal(run.revision, 'shakedown-board-' + createHash('sha256').update('dep_test').digest('hex').slice(0, 12));
  run.logError = new GcpError(429, 'Cloud Logging entries.list failed: HTTP 429');
  assert.deepEqual(await provider.appLogs('dep_test'), []);
  run.logError = new GcpError(403, 'Cloud Logging entries.list failed: HTTP 403');
  await assert.rejects(provider.appLogs('dep_test'), (e: unknown) => e instanceof GcpError && e.status === 403);
});

// 계획 배포: 등급 최소 대수와 JDBC 세션으로 보낸다. compute만 적용하므로 Cloud SQL은 읽지도 바꾸지도 않는다.
function planInput(tier: Tier): DeployRequest {
  return requestSchema.parse({ deployment_id: 'dep_plan', project_id: config.projectId, image, port: 8080, health_path: '/health',
    env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' }, secret_refs: { SPRING_DATASOURCE_PASSWORD: 'db_password' },
    architecture: { version: 'gcp-architecture.v1', template_id: tier }, options: { replicas: architectures[tier].min } });
}

test('a deploy without a plan sends byte-for-byte the same service and job bodies as before plans existed', async () => {
  const { run, provider } = setup();
  await provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  const vpcAccess = { networkInterfaces: [{ network: 'default', subnetwork: 'default' }], egress: 'PRIVATE_RANGES_ONLY' };
  const env = (initialize: boolean) => [
    { name: 'SPRING_DATASOURCE_URL', value: 'jdbc:postgresql://10.20.0.3:5432/board_db' },
    { name: 'SPRING_DATASOURCE_USERNAME', value: 'board' },
    { name: 'SPRING_JPA_HIBERNATE_DDL_AUTO', value: initialize ? 'update' : 'validate' },
    { name: 'SPRING_PROFILES_ACTIVE', value: initialize ? 'schema-init' : 'demo,session-jdbc' },
    { name: 'TZ', value: 'UTC' },
    { name: 'SPRING_DATASOURCE_PASSWORD', valueSource: { secretKeyRef: { secret: 'shakedown-db-password', version: 'latest' } } },
  ];
  const service = {
    template: {
      revision: 'shakedown-board-' + createHash('sha256').update('dep_test').digest('hex').slice(0, 12),
      containers: [{ name: 'app', image, ports: [{ containerPort: 8080 }], env: env(false), resources: { limits: { memory: '1Gi', cpu: '1' }, cpuIdle: true } }],
      vpcAccess, sessionAffinity: false,
    },
    scaling: { scalingMode: 'MANUAL', manualInstanceCount: 2 },
    invokerIamDisabled: false,
  };
  const job = { template: { taskCount: 1, template: {
    containers: [{ name: 'schema-init', image, env: env(true), resources: { limits: { memory: '1Gi', cpu: '1' } } }], maxRetries: 0, timeout: '180s', vpcAccess,
  } } };
  // PATCH 본문은 JSON 그대로 GCP로 간다. 키 순서까지 같은지 문자열로 비교한다.
  assert.equal(JSON.stringify(run.services[0]), JSON.stringify(service));
  assert.equal(JSON.stringify(run.jobs[0]), JSON.stringify(job));
});

test('plan deploys apply the catalog to the service: size, scaling mode, revision maximum, per-tier pool size and no affinity', async () => {
  const cases: [Tier, unknown, unknown, unknown, string | undefined][] = [
    ['small', { limits: { memory: '1Gi', cpu: '1' }, cpuIdle: true }, { scalingMode: 'MANUAL', manualInstanceCount: 1 }, undefined, undefined],
    ['medium', { limits: { memory: '2Gi', cpu: '1' }, cpuIdle: true }, { scalingMode: 'AUTOMATIC', minInstanceCount: 2, maxInstanceCount: 4 }, { maxInstanceCount: 4 }, '5'],
    ['large', { limits: { memory: '4Gi', cpu: '2' }, cpuIdle: true }, { scalingMode: 'AUTOMATIC', minInstanceCount: 3, maxInstanceCount: 8 }, { maxInstanceCount: 8 }, '2'],
  ];
  for (const [tier, resources, scaling, revisionScaling, pool] of cases) {
    const { run, provider } = setup();
    await provider.deploy(planInput(tier), AbortSignal.timeout(2_000), () => {});
    const service = run.services[0], container = service.template.containers[0];
    assert.deepEqual(container.resources, resources, tier);
    assert.deepEqual(service.scaling, scaling, tier);
    // 수동 모드에서는 리비전 min/max가 무시되므로 small에는 넣지 않는다.
    assert.equal('scaling' in service.template, revisionScaling !== undefined, tier);
    assert.deepEqual(service.template.scaling, revisionScaling, tier);
    assert.equal(service.template.sessionAffinity, false, tier);
    const env = Object.fromEntries((container.env ?? []).map(e => [e.name, e.value]));
    // small은 1대라 앱 기본 풀(10)을 그대로 둔다. env를 넣지 않는다.
    assert.equal(env.SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE, pool, tier);
    assert.equal(env.SPRING_PROFILES_ACTIVE, 'demo,session-jdbc', tier);
    // schema Job은 등급과 무관하게 1 vCPU / 1Gi, 기본 풀로 한 번만 돈다(쿼터 계산의 Job 몫).
    const task = run.jobs[0].template.template.containers[0];
    assert.deepEqual(task.resources, { limits: { memory: '1Gi', cpu: '1' } }, tier);
    assert.ok(!(task.env ?? []).some(e => e.name === 'SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE'), tier);
  }
});

test('plan deploys report the tier and the scaling range read back from Cloud Run, and nothing about DB availability', async () => {
  const common = { runtime: 'Cloud Run', region: 'asia-northeast3', database: 'Cloud SQL PostgreSQL', session: 'jdbc', sticky_sessions: 'false',
    image_digest: 'sha256:' + 'a'.repeat(64), revision: 'shakedown-board-00002-abc' };
  const medium = setup();
  assert.deepEqual(await medium.provider.deploy(planInput('medium'), AbortSignal.timeout(2_000), () => {}), { url: PUBLIC_URL, instances: 2, info: {
    ...common, scaling: 'automatic 2-4', architecture: 'medium',
  } });
  const small = setup();
  assert.deepEqual(await small.provider.deploy(planInput('small'), AbortSignal.timeout(2_000), () => {}), { url: PUBLIC_URL, instances: 1, info: {
    ...common, scaling: 'manual', architecture: 'small',
  } });
  // 서버가 리비전 상한을 더 크게 채워도 실제 상한은 둘 중 작은 값이라 카탈로그와 같다.
  const roomy = setup();
  roomy.run.readyPatch = { template: { containers: [{ image }], scaling: { maxInstanceCount: 100 } } };
  assert.equal((await roomy.provider.deploy(planInput('medium'), AbortSignal.timeout(2_000), () => {})).info.scaling, 'automatic 2-4');
});

test('a plan deploy fails before public health when Cloud Run does not keep the catalog range', async () => {
  // 2026-10-09 v2 GET에서 서버가 template.scaling.maxInstanceCount=3을 채운 것을 확인했다. 그대로 두면 medium이 3대에서 멈춘다.
  const cases: [string, Partial<RunService>][] = [
    ['revision max 3', { template: { containers: [{ image }], scaling: { maxInstanceCount: 3 } } }],
    ['service min 1', { scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 1, maxInstanceCount: 4 } }],
    ['no maximum', { scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 2 }, template: { containers: [{ image }] } }],
    // min/max는 카탈로그와 같고 모드만 MANUAL이다. 모드 검사가 빠지면 이 경우만 통과해 버린다.
    ['manual mode', { scaling: { scalingMode: 'MANUAL', minInstanceCount: 2, maxInstanceCount: 4 } }],
  ];
  for (const [label, patch] of cases) {
    const { run, provider } = setup();
    run.readyPatch = patch;
    const lines: string[] = [];
    await assert.rejects(provider.deploy(planInput('medium'), AbortSignal.timeout(2_000), line => lines.push(line)), /카탈로그와 다릅니다/, label);
    assert.ok(!run.actions.includes('fetch'), label);
    // 로그에서 어느 단계가 실패했는지 보이게 한다(wait_ready completed 다음 줄이 바로 실패면 원인을 찾기 어렵다).
    assert.ok(lines.some(l => l.startsWith('phase=verify_scaling failed')), label);
  }
});

test('plan deploys make the same Cloud Run calls and add only a verify_scaling phase between wait_ready and public_health', async () => {
  const { run, provider } = setup();
  const lines: string[] = [];
  await provider.deploy(planInput('medium'), AbortSignal.timeout(2_000), line => lines.push(line));
  assert.deepEqual(run.actions, ['getService', 'setPublic:true', 'runSchemaJob', 'putService', 'getService', 'fetch']);
  const started = lines.filter(l => l.endsWith(' started')).map(l => l.split(' ')[0]);
  assert.deepEqual(started, ['phase=grant_public', 'phase=schema_job', 'phase=update_service', 'phase=wait_ready', 'phase=verify_scaling', 'phase=public_health']);
  const plain = setup(), plainLines: string[] = [];
  await plain.provider.deploy(input(), AbortSignal.timeout(2_000), line => plainLines.push(line));
  assert.ok(!plainLines.some(l => l.includes('verify_scaling')));
});

test('stop keeps the measured count-only mask for a manual service and clears automatic min/max only after a plan deploy', async () => {
  // 계획 없는 배포가 남긴 수동 서비스: 2026-10-09에 실측한 마스크(대수만) 그대로 내린다.
  const plain = setup(200, 503), plainLines: string[] = [];
  await plain.provider.deploy(input(), AbortSignal.timeout(2_000), () => {});
  await plain.provider.stop(line => plainLines.push(line));
  assert.deepEqual(plain.run.clearedAutomatic, [false]);
  assert.ok(plainLines.includes('Cloud Run manual instance count set to 0'));
  // 자동 확장(medium) 서비스: 수동 0대로 바꾸면서 서비스 min/max도 지운다.
  const medium = setup(200, 503), mediumLines: string[] = [];
  await medium.provider.deploy(planInput('medium'), AbortSignal.timeout(2_000), () => {});
  await medium.provider.stop(line => mediumLines.push(line));
  assert.deepEqual(medium.run.clearedAutomatic, [true]);
  assert.ok(mediumLines.includes('Cloud Run set to manual scaling with 0 instances (automatic min/max cleared)'));
  // 서버가 수동 서비스에 min/max 값을 채워 돌려줘도 계획 없는 배포의 내리기는 실측한 마스크를 벗어나지 않는다.
  const filled = setup(503);
  filled.run.current = { template: { containers: [{ image: OLD_IMAGE }] }, scaling: { scalingMode: 'MANUAL', manualInstanceCount: 2, minInstanceCount: 1, maxInstanceCount: 100 } };
  await filled.provider.stop(() => {});
  assert.deepEqual(filled.run.clearedAutomatic, [false]);
  await plain.provider.settled(); await medium.provider.settled(); await filled.provider.settled();
});

test('a plan deploy refused at update_service is cleaned up with the measured mask when the service was still manual', async () => {
  // Cloud Run이 자동 확장 본문을 거절해도(400) 서비스는 이전의 수동 상태 그대로다. 실패 정리는 실측된 마스크로 0대를 만든다.
  const { run, provider } = setup(503);
  run.current = { template: { containers: [{ image: OLD_IMAGE }] }, scaling: { scalingMode: 'MANUAL', manualInstanceCount: 2 } };
  run.putService = async service => { run.actions.push('putService'); run.services.push(service); throw new GcpError(400, 'Cloud Run service update failed: HTTP 400'); };
  const store = new Store(':memory:'), manager = new Manager(store, provider);
  try {
    manager.create(planInput('medium')); await manager.drain();
    assert.equal(store.result('dep_plan').status, 'failed');
    assert.deepEqual(run.clearedAutomatic, [false]);
    assert.ok(!store.row('dep_plan')?.deleting, 'the project is not left locked');
  } finally { await provider.settled(); store.close(); }
});

test('when the scale-to-0 PATCH is refused, stop logs how to scale down by hand, rejects and still revokes public access', async () => {
  // 넓은 마스크(자동 확장 서비스용)는 아직 실측 전이다. 거절되면 Manager가 프로젝트를 잠그므로 운영자가 할 일을 배포 로그에 남긴다.
  const { run, provider } = setup(503);
  run.scaleError = new GcpError(400, 'Cloud Run scaling update failed: HTTP 400');
  const lines: string[] = [];
  await assert.rejects(provider.stop(line => lines.push(line)), (e: unknown) => e instanceof GcpError && e.status === 400);
  assert.ok(lines.some(l => l.startsWith('Cloud Run scale-to-0 failed;') && l.includes('README')), lines.join('\n'));
  await settle();
  assert.ok(run.actions.includes('setPublic:false'));
  await provider.settled();
});
