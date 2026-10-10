import { databaseEnvironment, validateRuntime, databaseUrl, managedDatabase } from '../../packages/contracts/runtime.mjs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { publicHealth } from './probe.mjs';
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const literal = value => String(value).replaceAll('$', () => '$$');

export function composeSpec(request, password, secrets = {}) {
  if (request.runtime) {
    const r=validateRuntime(request.runtime), managed=managedDatabase(r.database.mode);
    const env={...r.env,...secrets,PORT:String(r.port),TZ:request.options?.tz??'UTC',
      ...(managed?databaseEnvironment(r,{host:'db',username:'app',ssl:false}):{}),
      ...Object.fromEntries(Object.entries(r.database.bindings).filter(([,v])=>['password','postgres_url','mysql_url','mongodb_url'].includes(v)).map(([k,v])=>[k,v==='password'?password:databaseUrl({mode:r.database.mode,host:'db',username:'app',password,name:r.database.name,ssl:false})]))};
    const database = managed ? localDatabase(r.database.mode,r.database.name,password) : {};
    return {services:{
      ...(managed?{db:database.service}:{}),
      app:{image:request.image,environment:Object.fromEntries(Object.entries(env).map(([k,v])=>[k,literal(v)])),...(managed?{depends_on:{db:{condition:'service_healthy'}}}:{})},
      tunnel:{image:'cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07',command:['tunnel','--no-autoupdate','--protocol','http2','--url',`http://app:${r.port}`],depends_on:['app']},
    },...(managed?{volumes:{[r.database.mode==='postgres'?'pgdata':r.database.mode+'data']:{}},...(database.configs?{configs:database.configs}:{})}:{})};
  }
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
    for (const [env, ref] of Object.entries(request.runtime?.secret_refs ?? request.secret_refs ?? {})) {
      const value = this.secrets[ref] ?? (ref === 'db_password' ? this.password : undefined);
      if (typeof value !== 'string' || !value) throw new Error(`Unknown secret reference: ${ref}`);
      result[env] = value;
    }
    return result;
  }
  validate(request) {
    const secrets = this.resolved(request);
    if ((!request.runtime || managedDatabase(request.runtime.database.mode)) && !(secrets.SPRING_DATASOURCE_PASSWORD || this.password)) throw new Error('Set LOCAL_DB_PASSWORD or a database password secret reference');
  }
  redact(value) {
    let text = String(value);
    for (const secret of [this.password,...(this.generatedSecrets??[]), ...Object.values(this.secrets)].filter(Boolean).flatMap(v=>[v,encodeURIComponent(v)]).sort((a,b)=>b.length-a.length)) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  }
  async deploy(request, log) {
    const secrets = this.resolved(request);
    const spec = composeSpec(request, secrets.SPRING_DATASOURCE_PASSWORD || this.password, secrets);
    this.generatedSecrets=Object.entries(spec.services.db?.environment??{}).filter(([k])=>/password/i.test(k)).map(([,v])=>String(v).replaceAll('$$','$'));
    await mkdir(this.dir(request.deployment_id), { recursive: true, mode: 0o700 });
    const file = path.join(this.dir(request.deployment_id), 'compose.json');
    await writeFile(file, JSON.stringify(spec), { mode: 0o600 });
    await chmod(file, 0o600);
    log('Starting configured HTTP application and dependencies');
    try {
      if (!request.runtime || managedDatabase(request.runtime.database.mode)) await this.command(request.deployment_id, ['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
      if (!request.runtime) {
        await this.command(request.deployment_id, ['run', '--rm', '--no-deps', '-e', 'SPRING_PROFILES_ACTIVE=schema-init', '-e', 'SPRING_JPA_HIBERNATE_DDL_AUTO=update', 'app']);
      } else if (request.runtime.init_command.length) {
        const [entry,...args]=request.runtime.init_command;
        await this.command(request.deployment_id,['run','--rm','--no-deps','--entrypoint',entry,'app',...args]);
      }
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
            return { url, instances: 1, info: { runtime: 'Docker Compose', database: request.runtime?.database.mode==='none'?'none':request.runtime?.database.mode==='external'?'external':(request.runtime?.database.mode??'postgres'), timezone: request.options?.tz ?? 'UTC', sticky_sessions: 'false', replicas: '1' } };
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
    const spec=JSON.parse(await readFile(path.join(this.dir(id),'compose.json'),'utf8'));
    for (const service of ['app',...(spec.services.db?['db']:[]),'tunnel']) {
      const output = await this.command(id, ['logs', '--no-color', '--no-log-prefix', '--timestamps', '--tail', '200', service]);
      for (const line of output.split('\n').filter(Boolean)) {
        const match = line.match(/^(\S+)\s+(.*)$/);
        lines.push({ ts: match && !Number.isNaN(Date.parse(match[1])) ? new Date(match[1]).toISOString() : new Date().toISOString(), source: service === 'tunnel' ? 'deploy' : service, line: this.redact(match?.[2] ?? line) });
      }
    }
    return lines;
  }
}

// Reuse the maintained Docker Official Images and their initialization hooks.
function localDatabase(mode,name,password) {
  if(mode==='postgres')return {service:{image:'postgres:17-alpine',environment:{POSTGRES_DB:name,POSTGRES_USER:'app',POSTGRES_PASSWORD:literal(password)},volumes:['pgdata:/var/lib/postgresql/data'],healthcheck:{test:['CMD','pg_isready','-U','app','-d',name],interval:'2s',timeout:'3s',retries:60}}};
  const admin=randomBytes(32).toString('hex');
  if(mode==='mysql')return {service:{image:'mysql:8.4',environment:{MYSQL_DATABASE:name,MYSQL_USER:'app',MYSQL_PASSWORD:literal(password),MYSQL_ROOT_PASSWORD:admin},volumes:['mysqldata:/var/lib/mysql'],healthcheck:{test:['CMD-SHELL','MYSQL_PWD="$${MYSQL_PASSWORD}" mysql --protocol=TCP -h 127.0.0.1 -u app "$${MYSQL_DATABASE}" -e "SELECT 1" >/dev/null'],interval:'3s',timeout:'5s',retries:60}}};
  return {service:{image:'mongo:8.0',environment:{MONGO_INITDB_ROOT_USERNAME:'admin',MONGO_INITDB_ROOT_PASSWORD:admin,MONGO_INITDB_DATABASE:name,APP_DB_NAME:name,APP_DB_PASSWORD:literal(password)},volumes:['mongodbdata:/data/db'],configs:[{source:'mongo-init',target:'/docker-entrypoint-initdb.d/10-app.js'}],healthcheck:{test:['CMD','mongosh','--quiet','--eval',"const c=new Mongo('mongodb://127.0.0.1'); const d=c.getDB(process.env.APP_DB_NAME); if(!d.auth('app',process.env.APP_DB_PASSWORD))quit(1); d.runCommand({ping:1});"],interval:'3s',timeout:'5s',retries:60}},configs:{'mongo-init':{content:"const d=db.getSiblingDB(process.env.APP_DB_NAME); d.createUser({user:'app',pwd:process.env.APP_DB_PASSWORD,roles:[{role:'readWrite',db:process.env.APP_DB_NAME}]});"}}};
}
