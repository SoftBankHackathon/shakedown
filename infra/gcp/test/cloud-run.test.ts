import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudRun, type RunService, type RunJob } from '../src/cloud-run.js';
import { GcpError, ok, type Http, type HttpRequest, type HttpResponse } from '../src/gcp-http.js';
import { configSchema } from '../src/config.js';

// config.example.json 대신 여기서 값을 고정한다. URL·경로 단언이 예시 파일 내용에 끌려가지 않게 하려고.
const config = configSchema.parse({
  gcpProject: 'shakedown-511106', gcpProjectNumber: '700410260240', region: 'asia-northeast3',
  projectId: 'prj_board', serviceName: 'shakedown-board', jobName: 'shakedown-board-schema',
  imagePrefixes: ['asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/'],
  network: 'default', subnetwork: 'default', dbHost: '10.20.0.3', dbName: 'board_db',
  dbUsername: 'board', dbPasswordSecret: 'shakedown-db-password',
});
const RUN = 'https://run.googleapis.com/v2';
const SERVICE = `${RUN}/projects/shakedown-511106/locations/asia-northeast3/services/shakedown-board`;
const signal = new AbortController().signal;

// 정해 둔 응답을 차례로 돌려주고, 받은 요청을 calls에 남기는 가짜 Http.
function fake(...responses: HttpResponse[]) {
  const calls: HttpRequest[] = [];
  const http: Http = async request => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${request.method} ${request.url}`);
    return next;
  };
  return { run: new CloudRun(http, config), calls };
}

test('ok returns data on 2xx and throws GcpError with the status otherwise', () => {
  assert.deepEqual(ok({ status: 200, data: { a: 1 } }, 'thing'), { a: 1 });
  assert.throws(() => ok({ status: 429, data: {} }, 'thing'), (e: unknown) => e instanceof GcpError && e.status === 429 && e.message === 'thing failed: HTTP 429');
});

test('ok keeps the reason GCP gives in the error body', () => {
  const data = { error: { code: 400, message: 'spec.template.containers[0].resources.limits.memory: Invalid value', status: 'INVALID_ARGUMENT' } };
  assert.throws(() => ok({ status: 400, data }, 'Cloud Run service update'),
    (e: unknown) => e instanceof GcpError && e.message === 'Cloud Run service update failed: HTTP 400: spec.template.containers[0].resources.limits.memory: Invalid value');
  assert.throws(() => ok({ status: 403, data: { error: { message: 'x'.repeat(500) } } }, 'thing'), (e: unknown) => e instanceof Error && e.message.length === 'thing failed: HTTP 403: '.length + 300);
});

test('serviceUrl follows the deterministic run.app format', () => {
  assert.equal(fake().run.serviceUrl(), 'https://shakedown-board-700410260240.asia-northeast3.run.app');
});

test('getService reads the configured service and maps 404 to undefined', async () => {
  const { run, calls } = fake({ status: 200, data: { uri: 'https://x.run.app' } }, { status: 404, data: {} }, { status: 500, data: {} });
  assert.equal((await run.getService(signal))?.uri, 'https://x.run.app');
  assert.equal(await run.getService(signal), undefined);
  await assert.rejects(run.getService(signal), (e: unknown) => e instanceof GcpError && e.status === 500);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', SERVICE], ['GET', SERVICE], ['GET', SERVICE]]);
});

const OPERATION = 'projects/shakedown-511106/locations/asia-northeast3/operations/op-1';

test('putService patches the whole service with allowMissing and keeps calling wait until the operation is done', async () => {
  const service: RunService = { template: { containers: [{ image: 'img@sha256:' + 'a'.repeat(64) }] }, scaling: { scalingMode: 'MANUAL', manualInstanceCount: 1 } };
  // operations.wait는 작업이 끝나기 전에도 돌아올 수 있다(문서). done:false가 한 번 더 와도 다시 불러야 한다.
  const { run, calls } = fake(
    { status: 200, data: { name: OPERATION, done: false } },
    { status: 200, data: { name: OPERATION, done: false } },
    { status: 200, data: { name: OPERATION, done: true } },
  );
  await run.putService(service, signal);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${SERVICE}?allowMissing=true`);
  assert.deepEqual(calls[0].body, service);
  assert.deepEqual(calls.slice(1).map(c => [c.method, c.url, c.body]), [
    ['POST', `${RUN}/${OPERATION}:wait`, { timeout: '10s' }],
    ['POST', `${RUN}/${OPERATION}:wait`, { timeout: '10s' }],
  ]);
});

test('a finished operation with an error rejects with its message', async () => {
  const { run } = fake({ status: 200, data: { name: OPERATION, done: true, error: { code: 9, message: 'Revision failed to start' } } });
  await assert.rejects(run.putService({ template: { containers: [] } }, signal), /Revision failed to start/);
});

test('setInstances changes only scaling.manualInstanceCount by default, as measured on 2026-10-09', async () => {
  const { run, calls } = fake({ status: 200, data: { name: OPERATION, done: true } });
  await run.setInstances(0, signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${SERVICE}?updateMask=scaling.manualInstanceCount`);
  assert.deepEqual(calls[0].body, { scaling: { manualInstanceCount: 0 } });
});

test('setInstances with clearAutomatic switches to manual scaling with that count and clears automatic min/max', async () => {
  const { run, calls } = fake({ status: 200, data: { name: OPERATION, done: true } });
  await run.setInstances(0, signal, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  // 마스크에 있고 본문에 없는 min/max는 지워진다. 계획 배포(자동 확장)를 내린 뒤 서비스 min대가 남지 않게 한다.
  assert.equal(calls[0].url, `${SERVICE}?updateMask=scaling.scalingMode,scaling.manualInstanceCount,scaling.minInstanceCount,scaling.maxInstanceCount`);
  assert.deepEqual(calls[0].body, { scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 } });
});

test('setPublic(true) adds allUsers and keeps etag and every other binding', async () => {
  const policy = { version: 1, etag: 'BwX1', bindings: [
    { role: 'roles/run.developer', members: ['user:dev@example.com'] },
    { role: 'roles/run.invoker', members: ['serviceAccount:ci@example.iam.gserviceaccount.com'] },
  ] };
  const { run, calls } = fake({ status: 200, data: policy }, { status: 200, data: {} });
  await run.setPublic(true, signal);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `${SERVICE}:getIamPolicy`], ['POST', `${SERVICE}:setIamPolicy`]]);
  assert.deepEqual(calls[1].body, { policy: { version: 1, etag: 'BwX1', bindings: [
    { role: 'roles/run.developer', members: ['user:dev@example.com'] },
    { role: 'roles/run.invoker', members: ['serviceAccount:ci@example.iam.gserviceaccount.com', 'allUsers'] },
  ] } });
});

test('setPublic(false) removes only allUsers and drops the invoker binding when it becomes empty', async () => {
  const policy = { etag: 'BwX2', bindings: [
    { role: 'roles/run.developer', members: ['user:dev@example.com'] },
    { role: 'roles/run.invoker', members: ['allUsers'] },
  ] };
  const { run, calls } = fake({ status: 200, data: policy }, { status: 200, data: {} });
  await run.setPublic(false, signal);
  assert.deepEqual(calls[1].body, { policy: { etag: 'BwX2', bindings: [{ role: 'roles/run.developer', members: ['user:dev@example.com'] }] } });
});

test('setPublic skips the write when the policy already matches', async () => {
  const { run, calls } = fake({ status: 200, data: { etag: 'BwX3', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } });
  await run.setPublic(true, signal);
  assert.equal(calls.length, 1);
});

const JOB = `${RUN}/projects/shakedown-511106/locations/asia-northeast3/jobs/shakedown-board-schema`;
const EXECUTION = 'projects/shakedown-511106/locations/asia-northeast3/jobs/shakedown-board-schema/executions/exec-1';
const job: RunJob = { template: { taskCount: 1, template: { containers: [{ image: 'img@sha256:' + 'b'.repeat(64) }], maxRetries: 0 } } };

test('runSchemaJob updates the job, runs it and waits for the execution to succeed', async () => {
  const { run, calls } = fake(
    { status: 200, data: { name: OPERATION, done: true } },
    { status: 200, data: { name: OPERATION, done: false, metadata: { name: EXECUTION } } },
    { status: 200, data: { name: EXECUTION, taskCount: 1 } },
    { status: 200, data: { name: EXECUTION, taskCount: 1, succeededCount: 1, completionTime: '2026-10-09T00:00:10Z' } },
  );
  await run.runSchemaJob(job, signal);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ['PATCH', `${JOB}?allowMissing=true`], ['POST', `${JOB}:run`], ['GET', `${RUN}/${EXECUTION}`], ['GET', `${RUN}/${EXECUTION}`],
  ]);
  assert.deepEqual(calls[0].body, job);
});

test('runSchemaJob rejects when the execution has a failed task', async () => {
  const { run } = fake(
    { status: 200, data: { name: OPERATION, done: true } },
    { status: 200, data: { name: OPERATION, done: false, metadata: { name: EXECUTION } } },
    { status: 200, data: { name: EXECUTION, taskCount: 1, failedCount: 1 } },
  );
  await assert.rejects(run.runSchemaJob(job, signal), /schema-init job failed/);
});

test('runSchemaJob rejects when the execution completes without success', async () => {
  const { run } = fake(
    { status: 200, data: { name: OPERATION, done: true } },
    { status: 200, data: { name: OPERATION, done: false, metadata: { name: EXECUTION } } },
    { status: 200, data: { name: EXECUTION, taskCount: 1, succeededCount: 0, completionTime: '2026-10-09T00:00:10Z' } },
  );
  await assert.rejects(run.runSchemaJob(job, signal), /did not succeed/);
});

test('readLogs asks for the newest 50 service lines and returns them oldest first', async () => {
  const { run, calls } = fake({ status: 200, data: { entries: [
    { timestamp: '2026-10-09T00:00:03.123456Z', textPayload: 'third' },
    { timestamp: '2026-10-09T00:00:02Z', httpRequest: { status: 200 } },
    { timestamp: '2026-10-09T00:00:01Z', jsonPayload: { message: 'first', level: 'INFO' } },
  ] } });
  const lines = await run.readLogs('shakedown-board-0123456789ab', '2026-10-09T00:00:00.000Z', signal);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://logging.googleapis.com/v2/entries:list');
  assert.deepEqual(calls[0].body, {
    resourceNames: ['projects/shakedown-511106'],
    filter: 'resource.type="cloud_run_revision" AND resource.labels.service_name="shakedown-board" AND resource.labels.revision_name="shakedown-board-0123456789ab" AND timestamp>="2026-10-09T00:00:00.000Z"',
    orderBy: 'timestamp desc', pageSize: 50,
  });
  assert.deepEqual(lines, [
    { ts: '2026-10-09T00:00:01.000Z', source: 'app', line: 'first' },
    { ts: '2026-10-09T00:00:03.123Z', source: 'app', line: 'third' },
  ]);
});

test('readLogs without since does not filter by time', async () => {
  const { run, calls } = fake({ status: 200, data: {} });
  assert.deepEqual(await run.readLogs('shakedown-board-0123456789ab', undefined, signal), []);
  assert.equal((calls[0].body as { filter: string }).filter, 'resource.type="cloud_run_revision" AND resource.labels.service_name="shakedown-board" AND resource.labels.revision_name="shakedown-board-0123456789ab"');
});

test('readLogs turns the read quota error into GcpError 429', async () => {
  const { run } = fake({ status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } });
  await assert.rejects(run.readLogs('shakedown-board-0123456789ab', undefined, signal), (e: unknown) => e instanceof GcpError && e.status === 429);
});

test('getProject reads Resource Manager v3 by project number', async () => {
  const { run, calls } = fake({ status: 200, data: { name: 'projects/700410260240', projectId: 'shakedown-511106' } });
  assert.deepEqual(await run.getProject(signal), { name: 'projects/700410260240', projectId: 'shakedown-511106' });
  assert.deepEqual([calls[0].method, calls[0].url], ['GET', 'https://cloudresourcemanager.googleapis.com/v3/projects/700410260240']);
});
