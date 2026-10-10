import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';
import type { LogLine } from './model.js';
import type { Http } from './gcp-http.js';
import { ok } from './gcp-http.js';

const RUN = 'https://run.googleapis.com/v2';
const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v3';
const LOGGING = 'https://logging.googleapis.com/v2';
const INVOKER = 'roles/run.invoker';
const PUBLIC = 'allUsers';

export type RunEnv = { name: string; value?: string; valueSource?: { secretKeyRef: { secret: string; version: string } } };
export type RunContainer = {
  name?: string; image: string; env?: RunEnv[];
  ports?: { containerPort: number }[];
  resources?: { limits?: Record<string, string>; cpuIdle?: boolean };
};
export type RunVpcAccess = { networkInterfaces: { network: string; subnetwork: string }[]; egress: 'PRIVATE_RANGES_ONLY' | 'ALL_TRAFFIC' };
export type RunCondition = { type?: string; state?: string; message?: string };
// Cloud Run v2 Service 중 우리가 쓰는 칸만 적는다. uri부터는 GCP가 채우는 읽기 전용 값이다(int64는 JSON에서 문자열).
// scaling(서비스 수준)과 template.scaling(리비전 수준)은 따로다. 자동 확장의 실제 상한은 두 max 중 작은 값이다.
export type RunService = {
  template: { revision?: string; containers: RunContainer[]; vpcAccess?: RunVpcAccess; sessionAffinity?: boolean; scaling?: { minInstanceCount?: number; maxInstanceCount?: number } };
  scaling?: { scalingMode?: 'AUTOMATIC' | 'MANUAL'; manualInstanceCount?: number; minInstanceCount?: number; maxInstanceCount?: number };
  invokerIamDisabled?: boolean;
  uri?: string; generation?: string; observedGeneration?: string; reconciling?: boolean;
  latestReadyRevision?: string; latestCreatedRevision?: string; terminalCondition?: RunCondition;
};

type Operation = { name: string; done?: boolean; error?: { code?: number; message?: string }; metadata?: { name?: string } };

type Binding = { role: string; members: string[]; condition?: unknown };
type Policy = { version?: number; etag?: string; bindings?: Binding[] };

// Cloud Run v2 Job 중 우리가 쓰는 칸. Job.template(ExecutionTemplate) 안에 다시 template(TaskTemplate)이 있다.
export type RunJob = {
  template: { taskCount?: number; template: { containers: RunContainer[]; maxRetries?: number; timeout?: string; vpcAccess?: RunVpcAccess } };
};
type Execution = { name: string; completionTime?: string; taskCount?: number; succeededCount?: number; failedCount?: number; cancelledCount?: number };

type LogEntry = { timestamp?: string; textPayload?: string; jsonPayload?: { message?: unknown } };

export type RunProject = { name: string; projectId: string };

export class CloudRun {
  constructor(private http: Http, private config: Config) {}
  private get parent() { return `projects/${this.config.gcpProject}/locations/${this.config.region}`; }
  private get servicePath() { return `${this.parent}/services/${this.config.serviceName}`; }
  private get jobPath() { return `${this.parent}/jobs/${this.config.jobName}`; }

  // 결정적 주소 형식(SERVICE-PROJECT_NUMBER.REGION.run.app)이라 서비스를 조회하지 않고도 안다.
  serviceUrl(): string {
    const c = this.config;
    return `https://${c.serviceName}-${c.gcpProjectNumber}.${c.region}.run.app`;
  }

  async getService(signal?: AbortSignal): Promise<RunService | undefined> {
    const response = await this.http({ method: 'GET', url: `${RUN}/${this.servicePath}`, signal });
    if (response.status === 404) return undefined;
    return ok<RunService>(response, 'Cloud Run service get');
  }

  // updateMask 없이 PATCH하면 서비스 전체를 이 값으로 바꾼다. allowMissing=true라 첫 배포에는 새로 만든다.
  async putService(service: RunService, signal: AbortSignal): Promise<void> {
    const response = await this.http({ method: 'PATCH', url: `${RUN}/${this.servicePath}?allowMissing=true`, body: service, signal });
    await this.wait(ok<Operation>(response, 'Cloud Run service update'), 'Cloud Run service update', signal);
  }

  // 대수만 바꾼다. 수동 스케일링의 대수 변경은 새 리비전을 만들지 않아 빨리 끝난다.
  async setInstances(count: number, signal: AbortSignal): Promise<void> {
    const response = await this.http({ method: 'PATCH', url: `${RUN}/${this.servicePath}?updateMask=scaling.manualInstanceCount`, body: { scaling: { manualInstanceCount: count } }, signal });
    await this.wait(ok<Operation>(response, 'Cloud Run scaling update'), 'Cloud Run scaling update', signal);
  }

  // setIamPolicy는 정책 전체를 덮어쓴다. 그래서 읽은 정책에서 allUsers만 넣고 빼고, 나머지 binding과 etag는 그대로 돌려보낸다.
  // etag가 그사이 바뀌었으면 GCP가 거절하므로 남의 변경을 덮어쓰지 않는다.
  async setPublic(open: boolean, signal: AbortSignal): Promise<void> {
    const policy = ok<Policy>(await this.http({ method: 'GET', url: `${RUN}/${this.servicePath}:getIamPolicy`, signal }), 'Cloud Run getIamPolicy');
    const all = policy.bindings ?? [];
    // 조건부 binding은 건드리지 않는다. 조건 없는 invoker binding 하나만 다룬다.
    const invoker = all.find(b => b.role === INVOKER && !b.condition);
    if ((invoker?.members.includes(PUBLIC) ?? false) === open) return;
    let bindings: Binding[];
    if (open) {
      bindings = invoker ? all.map(b => (b === invoker ? { ...b, members: [...b.members, PUBLIC] } : b)) : [...all, { role: INVOKER, members: [PUBLIC] }];
    } else {
      const members = invoker!.members.filter(m => m !== PUBLIC);
      bindings = all.flatMap(b => (b !== invoker ? [b] : members.length ? [{ ...b, members }] : []));
    }
    ok(await this.http({ method: 'POST', url: `${RUN}/${this.servicePath}:setIamPolicy`, body: { policy: { ...policy, bindings } }, signal }), 'Cloud Run setIamPolicy');
  }

  // Job 실행 때는 이미지를 바꿀 수 없다. 그래서 매번 Job을 이번 이미지로 갱신한 뒤 실행한다.
  async runSchemaJob(job: RunJob, signal: AbortSignal): Promise<void> {
    const update = await this.http({ method: 'PATCH', url: `${RUN}/${this.jobPath}?allowMissing=true`, body: job, signal });
    await this.wait(ok<Operation>(update, 'Cloud Run job update'), 'Cloud Run job update', signal);
    const run = ok<Operation>(await this.http({ method: 'POST', url: `${RUN}/${this.jobPath}:run`, body: {}, signal }), 'Cloud Run job run');
    // RunJob 작업의 metadata는 Execution이다(job.proto). 작업이 언제 done이 되는지는 문서에 없어서 Execution을 직접 지켜본다.
    const name = run.metadata?.name;
    if (!name) throw new Error('Cloud Run job run: execution name missing');
    while (true) {
      const execution = ok<Execution>(await this.http({ method: 'GET', url: `${RUN}/${name}`, signal }), 'Cloud Run execution get');
      // 재시도 0회로 돌리므로 실패한 task가 하나라도 있으면 끝까지 기다릴 이유가 없다.
      if (execution.failedCount || execution.cancelledCount) throw new Error(`schema-init job failed: ${name}`);
      if (execution.completionTime) {
        if ((execution.succeededCount ?? 0) >= (execution.taskCount ?? 1)) return;
        throw new Error(`schema-init job did not succeed: ${name}`);
      }
      await sleep(2_000, undefined, { signal });
    }
  }

  // 한 리비전(= 한 배포)의 앱 로그만 읽는다. 서비스는 배포마다 같아서 서비스 이름만으로 거르면 다른 배포의 로그가 섞인다.
  async readLogs(revision: string, since: string | undefined, signal: AbortSignal): Promise<LogLine[]> {
    const c = this.config;
    // since는 app.ts가 ISO 날짜로 검사하고 다시 만든 값이고, revision은 GcpProvider가 해시로 만든 이름이라 필터 문자열에 그대로 넣어도 안전하다.
    const filter = [`resource.type="cloud_run_revision"`, `resource.labels.service_name="${c.serviceName}"`, `resource.labels.revision_name="${revision}"`,
      ...(since ? [`timestamp>="${since}"`] : [])].join(' AND ');
    const response = await this.http({ method: 'POST', url: `${LOGGING}/entries:list`, body: { resourceNames: [`projects/${c.gcpProject}`], filter, orderBy: 'timestamp desc', pageSize: 50 }, signal });
    // 한도 초과(429)도 ok()가 GcpError(429)로 던진다. 어떻게 다룰지는 GcpProvider가 정한다.
    const result = ok<{ entries?: LogEntry[] }>(response, 'Cloud Logging entries.list');
    // 최신 50줄을 내림차순으로 받았으니 뒤집어 시간순으로 돌려준다. 요청 로그처럼 글이 없는 항목은 뺀다.
    return (result.entries ?? []).flatMap(entry => {
      const message = entry.jsonPayload?.message;
      const line = entry.textPayload ?? (typeof message === 'string' ? message : undefined);
      // 시각 자릿수를 배포 로그(toISOString)와 맞춰야 문자열 정렬이 시간 순서와 같아진다.
      return line === undefined || !entry.timestamp ? [] : [{ ts: new Date(entry.timestamp).toISOString(), source: 'app' as const, line }];
    }).reverse();
  }

  // v3 Project에는 projectNumber 칸이 없고 name이 "projects/{번호}"다. 문서 예시대로 번호로 조회한다.
  async getProject(signal: AbortSignal): Promise<RunProject> {
    const response = await this.http({ method: 'GET', url: `${RESOURCE_MANAGER}/projects/${this.config.gcpProjectNumber}`, signal });
    return ok<RunProject>(response, 'Resource Manager project get');
  }

  // 오래 걸리는 작업(Operation)이 끝날 때까지 기다린다. operations.wait는 일찍 돌아올 수 있다고 문서에 적혀 있어 done이 될 때까지 다시 부른다.
  private async wait(operation: Operation, what: string, signal: AbortSignal): Promise<void> {
    while (!operation.done) {
      operation = ok<Operation>(await this.http({ method: 'POST', url: `${RUN}/${operation.name}:wait`, body: { timeout: '10s' }, signal }), `${what} wait`);
      if (!operation.done) await sleep(1_000, undefined, { signal });
    }
    if (operation.error) throw new Error(`${what} failed: ${operation.error.message ?? `code ${operation.error.code}`}`);
  }
}
