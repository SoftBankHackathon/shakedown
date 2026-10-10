import { validateRuntime } from '../../packages/contracts/runtime.mjs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerRuntime } from './runtime.mjs';
import { deliveryConfig } from './delivery.mjs';

const ID = /^dep_[a-z0-9]+$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function validate(input) {
  if (!object(input)) throw new Error('Expected JSON object');
  if (!ID.test(input.deployment_id)) throw new Error('Invalid deployment_id');
  if (typeof input.project_id !== 'string' || !/^[-a-zA-Z0-9_]{1,100}$/.test(input.project_id)) throw new Error('Invalid project_id');
  if (typeof input.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,500}$/.test(input.image)) throw new Error('Invalid image');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('Invalid port');
  if (typeof input.health_path !== 'string' || !input.health_path.startsWith('/') || input.health_path.startsWith('//') || /[\s\\#]/.test(input.health_path)) throw new Error('Invalid health_path');
  for (const field of ['env','secret_refs']) {
    if (input[field] !== undefined && (!object(input[field]) || Object.entries(input[field]).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')))) throw new Error(`Invalid ${field}`);
  }
  if (input.database !== undefined && (!object(input.database) || input.database.engine !== 'postgres' || (input.database.name !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(input.database.name)))) throw new Error('Only PostgreSQL is supported; use database.engine=postgres');
  if (input.options !== undefined && !object(input.options)) throw new Error('Invalid options');
  const opts = input.options ?? {};
  if (opts.replicas !== undefined && (!Number.isInteger(opts.replicas) || opts.replicas < 1)) throw new Error('Invalid replicas');
  if (opts.sticky_sessions !== undefined && typeof opts.sticky_sessions !== 'boolean') throw new Error('Invalid sticky_sessions');
  if (opts.tz !== undefined) {
    if (typeof opts.tz !== 'string') throw new Error('Invalid tz');
    try { new Intl.DateTimeFormat('en', { timeZone: opts.tz }); } catch { throw new Error('Invalid tz'); }
  }
  if (input.runtime !== undefined) {
    validateRuntime(input.runtime);
    if (input.port!==input.runtime.port || input.health_path!==input.runtime.health_path || input.database || Object.keys(input.env??{}).length || Object.keys(input.secret_refs??{}).length) throw new Error('Do not mix runtime and legacy settings');
  }
  return input;
}

function fingerprint(input) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(sorted(input))).digest('hex');
}

export async function createService({ root, runtime }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const records = new Map();
  const jobs = new Map();
  const deleting = new Set();
  const save = async record => {
    const dir = path.join(root, record.state.deployment_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir,'state.tmp'), JSON.stringify(record), { mode: 0o600 });
    await rename(path.join(dir,'state.tmp'), path.join(dir,'state.json'));
  };
  for (const name of await readdir(root)) {
    if (!ID.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(root,name,'state.json'),'utf8'));
      if (['pending','deploying'].includes(record.state.status)) {
        record.state.status = 'failed'; record.state.error = 'Service restarted during deployment; inspect logs, delete and retry with a new ID';
        await save(record);
      }
      records.set(name, record);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const respond = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const run = async (record, input) => {
    const log = line => record.lines.push({ ts: new Date().toISOString(), source: 'deploy', line });
    try {
      record.state.status = 'deploying'; await save(record);
      const result = await runtime.deploy(input, log);
      Object.assign(record.state, result, { status: 'ready', ready_at: new Date().toISOString() });
    } catch (error) {
      record.state.status = 'failed'; record.state.error = runtime.redact?.(error.message) ?? error.message;
      log(record.state.error);
    }
    await save(record);
  };
  const server = http.createServer(async (req, res) => {
    try {
      // This API controls Docker and must not be called cross-origin from webpages.
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return respond(res, 403, { error: 'Browser cross-origin access is disabled' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return respond(res,200,{ok:true,target:'local'});
      if (req.method === 'POST' && url.pathname === '/deployments') {
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 65536) return respond(res,413,{error:'Request too large'}); chunks.push(part); }
        let input;
        try { input = validate(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { return respond(res,400,{error:error.message}); }
        const id = input.deployment_id;
        if (deleting.has(id)) return respond(res,409,{error:'Deployment is being removed'});
        if (records.has(id)) {
          const existing = records.get(id);
          if (existing.deleted || (existing.fingerprint && existing.fingerprint !== fingerprint(input))) return respond(res,409,{error:'Deployment ID is deleted or belongs to another request'});
          return respond(res,202,existing.state);
        }
        if (runtime.singleDeployment && [...records.values()].some(r=>!r.deleted)) return respond(res,409,{error:'Direct endpoint is reserved; delete the existing deployment before deploying another'});
        if ([...records.values()].some(r => r.project_id === input.project_id && ['pending','deploying'].includes(r.state.status))) return respond(res,409,{error:'Project deployment already in progress'});
        try { runtime.validate?.(input); } catch (error) { return respond(res,400,{error:error.message}); }
        const record = { fingerprint: fingerprint(input), project_id: input.project_id, state: { deployment_id:id,target:'local',status:'pending',started_at:new Date().toISOString() }, lines:[] };
        records.set(id,record); // Reserve before the first await to enforce idempotency.
        const job = (async () => { await save(record); await run(record,input); })();
        jobs.set(id, job);
        job.catch(error => { record.state.status = 'failed'; record.state.error = 'Unable to persist deployment state'; console.error('Deployment state persistence failed:', error.code ?? 'unknown'); }).finally(()=>jobs.delete(id));
        return respond(res,202,record.state);
      }
      const match = url.pathname.match(/^\/deployments\/(dep_[a-z0-9]+)(\/logs)?$/);
      if (!match || !records.has(match[1])) return respond(res,404,{error:'Not found'});
      const id = match[1], record = records.get(id);
      if (req.method === 'GET' && !match[2]) return record.deleted ? respond(res,404,{error:'Not found'}) : respond(res,200,record.state);
      if (req.method === 'GET' && match[2]) {
        const since = url.searchParams.get('since');
        if (since && Number.isNaN(Date.parse(since))) return respond(res,400,{error:'Invalid since timestamp'});
        let lines = [...record.lines];
        try { if (!record.deleted) lines.push(...await runtime.logs(id)); } catch { lines.push({ts:new Date().toISOString(),source:'deploy',line:'Container logs not available yet'}); }
        lines = lines.filter(line=>!since || Date.parse(line.ts) >= Date.parse(since)).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
        return respond(res,200,{lines});
      }
      if (req.method === 'DELETE' && !match[2]) {
        if (record.deleted) return respond(res,204);
        if (deleting.has(id)) return respond(res,409,{error:'Deployment is being removed'});
        deleting.add(id);
        try {
          await jobs.get(id);
          try { record.lines.push(...await runtime.logs(id)); } catch { /* deployment logs still available */ }
          await runtime.remove(id);
          record.deleted = true;
          await save(record);
          await rm(path.join(root,id,'compose.json'), {force:true});
          return respond(res,204);
        } finally { deleting.delete(id); }
      }
      return respond(res,405,{error:'Method not allowed'});
    } catch (error) { respond(res,500,{error:runtime.redact?.(error.message) ?? error.message}); }
  });
  server.requestTimeout = 15000;
  return { server, settle: () => Promise.allSettled([...jobs.values()]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.env.LOCAL_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)),'.data'));
  const secrets = process.env.LOCAL_SECRETS_FILE ? JSON.parse(await readFile(process.env.LOCAL_SECRETS_FILE,'utf8')) : {};
  const runtime = new DockerRuntime(root,{delivery:deliveryConfig(process.env),password:process.env.LOCAL_DB_PASSWORD,secrets});
  const {server} = await createService({root,runtime});
  server.listen(Number(process.env.PORT ?? 9101),'127.0.0.1',()=>console.log(`Local target API: http://127.0.0.1:${server.address().port}`));
}
