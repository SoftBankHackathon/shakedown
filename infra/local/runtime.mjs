import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { publicHealth } from './probe.mjs';
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const literal = value => String(value).replaceAll('$', () => '$$');

export function composeSpec(request, password, secrets = {}) {
  const database = request.database?.name ?? 'board_db';
  const env = {
    ...request.env, ...secrets,
    PORT: String(request.port),
    SPRING_DATASOURCE_URL: `jdbc:postgresql://db:5432/${database}`,
    SPRING_DATASOURCE_USERNAME: 'board',
    SPRING_DATASOURCE_PASSWORD: password,
    TZ: request.options?.tz ?? 'UTC',
  };
  return {
    services: {
      db: {
        image: 'postgres:17-alpine',
        environment: { POSTGRES_DB: database, POSTGRES_USER: 'board', POSTGRES_PASSWORD: literal(password) },
        volumes: ['pgdata:/var/lib/postgresql/data'],
        healthcheck: { test: ['CMD', 'pg_isready', '-U', 'board', '-d', database], interval: '2s', timeout: '3s', retries: 30 },
      },
      app: {
        image: request.image,
        environment: Object.fromEntries(Object.entries(env).map(([k,v]) => [k,literal(v)])),
        depends_on: { db: { condition: 'service_healthy' } },
      },
      tunnel: {
        image: 'cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07',
        command: ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://app:${request.port}`],
        depends_on: ['app'],
      },
    },
    volumes: { pgdata: {} },
  };
}

export class DockerRuntime {
  constructor(root, { password, secrets = {}, timeout = 170000 } = {}) {
    this.root = root; this.password = password; this.secrets = secrets; this.timeout = timeout;
  }
  dir(id) { return path.join(this.root, id); }
  async command(id, args) {
    const base = ['compose', '-p', `sd-${id.replaceAll('_','-')}`, '-f', path.join(this.dir(id), 'compose.json')];
    // execFile never invokes a shell; all names and IDs are validated at the API boundary.
    const { stdout, stderr } = await exec('docker', [...base, ...args], { timeout: this.timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout + stderr;
  }
  resolved(request) {
    const result = {};
    for (const [env, ref] of Object.entries(request.secret_refs ?? {})) {
      const value = this.secrets[ref] ?? (ref === 'db_password' ? this.password : undefined);
      if (typeof value !== 'string' || !value) throw new Error(`Unknown secret reference: ${ref}`);
      result[env] = value;
    }
    return result;
  }
  validate(request) {
    const secrets = this.resolved(request);
    if (!(secrets.SPRING_DATASOURCE_PASSWORD || this.password)) throw new Error('Set LOCAL_DB_PASSWORD or a database password secret reference');
  }
  redact(value) {
    let text = String(value);
    for (const secret of [this.password, ...Object.values(this.secrets)].filter(Boolean).sort((a,b)=>b.length-a.length)) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  }
  async deploy(request, log) {
    const secrets = this.resolved(request);
    const spec = composeSpec(request, secrets.SPRING_DATASOURCE_PASSWORD || this.password, secrets);
    await mkdir(this.dir(request.deployment_id), { recursive: true, mode: 0o700 });
    const file = path.join(this.dir(request.deployment_id), 'compose.json');
    await writeFile(file, JSON.stringify(spec), { mode: 0o600 });
    await chmod(file, 0o600);
    log('Starting PostgreSQL, app and Cloudflare Tunnel');
    try {
      await this.command(request.deployment_id, ['up', '-d', '--wait', '--wait-timeout', '90']);
    } catch (e) {
      // exec errors may contain environment data; expose only redacted diagnostics.
      throw new Error(this.redact(e.stderr || e.message));
    }
    const deadline = Date.now() + 90000;
    let url;
    while (Date.now() < deadline) {
      const logs = await this.command(request.deployment_id, ['logs', '--no-color', '--tail', '100', 'tunnel']);
      url = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
      if (url) {
        try {
          if (await publicHealth(url + request.health_path)) {
            log('Public health check returned HTTP 200');
            return { url, instances: 1, info: { runtime: 'Docker Compose', database: 'PostgreSQL 17', timezone: request.options?.tz ?? 'UTC', sticky_sessions: 'false', replicas: '1' } };
          }
        } catch { /* DNS and tunnel readiness may lag container startup. */ }
      }
      await sleep(2000);
    }
    throw new Error('Public health check timed out; inspect app and tunnel logs');
  }
  async remove(id) { await this.command(id, ['down', '--remove-orphans']); }
  async logs(id) {
    const lines = [];
    for (const service of ['app','db','tunnel']) {
      const output = await this.command(id, ['logs', '--no-color', '--no-log-prefix', '--timestamps', '--tail', '200', service]);
      for (const line of output.split('\n').filter(Boolean)) {
        const match = line.match(/^(\S+)\s+(.*)$/);
        lines.push({ ts: match && !Number.isNaN(Date.parse(match[1])) ? new Date(match[1]).toISOString() : new Date().toISOString(), source: service === 'tunnel' ? 'deploy' : service, line: this.redact(match?.[2] ?? line) });
      }
    }
    return lines;
  }
}
