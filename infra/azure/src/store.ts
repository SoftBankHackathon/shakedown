import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Deployment, DeployRequest, LogLine } from './model.js';
import { ApiError, redact } from './model.js';

export type RecordRow = { id: string; project: string; hash: string; body: string; result: string; deleted: number; deleting: number; sequence: number };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deployments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS logs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL, line TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  bindStack(identity: string) {
    const old = this.db.prepare("SELECT value FROM metadata WHERE key='stack'").get() as { value: string } | undefined;
    if (old && old.value !== identity) throw new Error('State DB belongs to a different Azure stack/project. Use its original configuration.');
    this.db.prepare("INSERT OR IGNORE INTO metadata (key,value) VALUES ('stack',?)").run(identity);
  }
  row(id: string): RecordRow | undefined { return this.db.prepare('SELECT * FROM deployments WHERE id=?').get(id) as RecordRow | undefined; }
  latest(project: string): RecordRow | undefined { return this.db.prepare('SELECT * FROM deployments WHERE project=? ORDER BY sequence DESC LIMIT 1').get(project) as RecordRow | undefined; }
  result(id: string): Deployment {
    const row = this.row(id);
    if (!row || row.deleted) throw new ApiError(404, '배포를 찾을 수 없습니다.');
    return JSON.parse(row.result);
  }
  accept(request: DeployRequest): { created: boolean; result: Deployment } {
    const body = canonical(request), hash = createHash('sha256').update(body).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.row(request.deployment_id);
      if (old) {
        if (old.deleted || old.deleting || old.hash !== hash) throw new ApiError(409, '이미 사용된 배포 ID이거나 요청 내용이 다릅니다.');
        this.db.exec('COMMIT');
        return { created: false, result: JSON.parse(old.result) };
      }
      const latest = this.latest(request.project_id);
      if (latest && !latest.deleted && (latest.deleting || ['pending', 'deploying'].includes(JSON.parse(latest.result).status))) throw new ApiError(409, '이 프로젝트의 배포 또는 정리가 진행 중입니다.');
      const result: Deployment = { deployment_id: request.deployment_id, target: 'azure', status: 'pending' };
      this.db.prepare('INSERT INTO deployments (id,project,hash,body,result) VALUES (?,?,?,?,?)').run(request.deployment_id, request.project_id, hash, body, JSON.stringify(result));
      this.db.exec('COMMIT');
      return { created: true, result };
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  update(id: string, patch: Partial<Deployment>) {
    const row = this.row(id)!;
    this.db.prepare('UPDATE deployments SET result=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.result), ...patch }), id);
  }
  deleting(id: string) { this.db.prepare('UPDATE deployments SET deleting=1 WHERE id=?').run(id); }
  deleted(id: string) { this.db.prepare('UPDATE deployments SET deleting=0,deleted=1 WHERE id=?').run(id); }
  unfinished(): RecordRow[] {
    return (this.db.prepare('SELECT * FROM deployments WHERE deleted=0').all() as RecordRow[]).filter(r => r.deleting || ['pending', 'deploying'].includes(JSON.parse(r.result).status));
  }
  log(id: string, line: string) { this.db.prepare('INSERT INTO logs (id,ts,source,line) VALUES (?,?,?,?)').run(id, new Date().toISOString(), 'deploy', redact(line)); }
  logs(id: string, since?: string): LogLine[] {
    return (this.db.prepare('SELECT ts,source,line FROM logs WHERE id=? AND ts>=? ORDER BY sequence DESC LIMIT 200').all(id, since ?? '') as LogLine[]).reverse();
  }
  close() { this.db.close(); }
}
