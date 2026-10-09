import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { type Job, type Endpoint, HttpsError } from "./model.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, project TEXT NOT NULL, target TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, UNIQUE(project,target))",
    );
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  get(project: string, target: string): Job | undefined {
    const r = this.db
      .prepare("SELECT payload FROM bindings WHERE project=? AND target=?")
      .get(project, target) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : undefined;
  }
  all(): Job[] {
    return (
      this.db.prepare("SELECT payload FROM bindings").all() as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));
  }
  save(j: Job) {
    this.db
      .prepare("UPDATE bindings SET payload=? WHERE id=?")
      .run(JSON.stringify(j), j.result.binding_id);
  }
  create(config: Endpoint, domain: string, now = Date.now()): Job {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(config.projectId, config.target);
      if (old) {
        if (
          old.result.domain !== domain ||
          JSON.stringify(old.config) !== JSON.stringify(config)
        )
          throw new HttpsError(
            "BINDING_CONFLICT",
            "이 대상에 다른 도메인 또는 리소스 연결이 있습니다.",
            409,
          );
        this.db.exec("COMMIT");
        return old;
      }
      const j: Job = {
        config,
        data: {},
        rollbackPending: false,
        result: {
          binding_id: "tls_" + randomUUID().replaceAll("-", ""),
          project_id: config.projectId,
          target: config.target,
          kind: config.kind,
          domain,
          status: "preflight",
          dns_records: [],
          checks: [],
          origin_url: config.originUrl,
          deployment_origin: config.deploymentOrigin ?? config.originUrl,
          internal_transport: config.internalTransport,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          next_check_at: new Date(now).toISOString(),
          deadline: new Date(now + 86_400_000).toISOString(),
        },
      };
      this.db
        .prepare("INSERT INTO bindings VALUES (?,?,?,?,?)")
        .run(
          j.result.binding_id,
          config.projectId,
          config.target,
          domain,
          JSON.stringify(j),
        );
      this.db.exec("COMMIT");
      return j;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (e instanceof HttpsError) throw e;
      throw new HttpsError(
        "DOMAIN_CONFLICT",
        "이미 다른 대상에 등록된 도메인입니다.",
        409,
      );
    }
  }
  acquire(owner: string) {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS process_lock (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER, owner TEXT)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT pid FROM process_lock WHERE id=1")
        .get() as { pid: number } | undefined;
      if (current) {
        try {
          process.kill(current.pid, 0);
          throw new HttpsError(
            "ALREADY_RUNNING",
            "같은 상태 저장소의 HTTPS 서비스가 이미 실행 중입니다.",
            409,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
      this.db
        .prepare("INSERT OR REPLACE INTO process_lock VALUES (1,?,?)")
        .run(process.pid, owner);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  release(owner: string) {
    this.db.prepare("DELETE FROM process_lock WHERE owner=?").run(owner);
  }
  close() {
    this.db.close();
  }
}
