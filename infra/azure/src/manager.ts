import type { DeployRequest, Provider } from './model.js';
import { ApiError, redact } from './model.js';
import { Store } from './store.js';

export class Manager {
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private removals = new Map<string, Promise<void>>();
  constructor(public store: Store, private provider: Provider, private timeoutMs = 270_000) {}
  async recover() {
    // Do not replay side effects after a crash. Fail closed, preserving evidence and IDs.
    for (const row of this.store.unfinished()) {
      if (this.store.latest(row.project)?.id === row.id) {
        await this.provider.stop(line => this.store.log(row.id, line));
      }
      if (row.deleting) this.store.deleted(row.id);
      else this.store.update(row.id, { status: 'failed', error: '어댑터 재시작으로 중단되었습니다. 로그 확인 후 새 배포 ID로 재시도하세요.' });
      this.store.log(row.id, 'recovery completed: interrupted deployment closed');
    }
  }
  async create(request: DeployRequest) {
    this.provider.validate(request);
    // 202 전에 ACR에 digest가 실제로 있는지 확인해서, 없으면 400으로 거절한다.
    await this.provider.precheck(request);
    const accepted = this.store.accept(request);
    if (accepted.created) {
      const controller = new AbortController();
      const done = this.run(request, controller);
      this.jobs.set(request.deployment_id, { controller, done });
      void done.finally(() => this.jobs.delete(request.deployment_id));
    }
    return accepted.result;
  }
  private async run(request: DeployRequest, controller: AbortController) {
    const id = request.deployment_id, started = Date.now();
    const log = (line: string) => this.store.log(id, line);
    const timer = setTimeout(() => controller.abort(new Error('배포 준비 제한 시간 초과')), this.timeoutMs);
    this.store.update(id, { status: 'deploying', started_at: new Date().toISOString() });
    log('deployment started');
    try {
      const result = await this.provider.deploy(request, controller.signal, log);
      controller.signal.throwIfAborted();
      this.store.update(id, { ...result, status: 'ready', ready_at: new Date().toISOString() });
      log(`deployment completed duration_ms=${Date.now() - started}`);
    } catch (error) {
      // A partial/failed rollout must not remain publicly accessible.
      let cleanupError = '';
      try { await this.provider.stop(log); } catch { cleanupError = ' 공개 차단/정리 확인 실패: DELETE 재시도가 필요합니다.'; }
      this.store.update(id, { status: 'failed', error: redact((error instanceof Error ? error.message : '배포 실패') + cleanupError) });
      if (cleanupError) this.store.deleting(id); // Keep project locked until cleanup succeeds.
      log(`deployment failed duration_ms=${Date.now() - started}${cleanupError}`);
    } finally { clearTimeout(timer); }
  }
  async remove(id: string): Promise<void> {
    const existing = this.removals.get(id);
    if (existing) return existing;
    const row = this.store.row(id);
    if (!row) throw new ApiError(404, '배포를 찾을 수 없습니다.');
    if (row.deleted) return;
    this.store.deleting(id);
    const task = (async () => {
      const job = this.jobs.get(id);
      job?.controller.abort(new Error('배포 삭제 요청'));
      await job?.done;
      if (this.store.latest(row.project)?.id === id) await this.provider.stop(line => this.store.log(id, line));
      this.store.deleted(id);
      this.store.log(id, 'deployment deleted; database and evidence retained');
    })();
    this.removals.set(id, task);
    try { await task; } finally { this.removals.delete(id); }
  }
  async logs(id: string, since?: string) {
    if (!this.store.row(id)) throw new ApiError(404, '배포를 찾을 수 없습니다.');
    let app = [] as Awaited<ReturnType<Provider['appLogs']>>;
    try { app = await this.provider.appLogs(id, since); } catch { this.store.log(id, 'app logs unavailable; deployment logs retained'); }
    return { lines: [...this.store.logs(id, since), ...app.map(l => ({ ...l, line: redact(l.line) }))].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-200) };
  }
  async drain() { await Promise.all([...this.jobs.values()].map(j => j.done)); }
}
