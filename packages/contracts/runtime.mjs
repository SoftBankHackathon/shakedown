// Shared adapter validation: never execute user-supplied initialization through a host shell.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v,keys) => object(v) && Object.keys(v).every(k=>keys.includes(k));
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function validateRuntime(r) {
  if (!only(r,['version','port','health_path','env','secret_refs','database','init_command']) || r.version!=='http-runtime.v1' || !Number.isInteger(r.port) || r.port<1 || r.port>65535 || typeof r.health_path!=='string' || r.health_path.length>256 || !/^\/(?!\/)[^\s?#\\]*$/.test(r.health_path)) throw new Error('Invalid HTTP runtime');
  const d=r.database;
  if (!only(d,['mode','name','bindings']) || !['none','postgres','external'].includes(d.mode) || !/^[a-z][a-z0-9_]{0,62}$/.test(d.name) || !object(d.bindings)) throw new Error('Invalid database runtime');
  if (!object(r.env) || !object(r.secret_refs) || Object.keys(r.env).length>64 || Object.keys(r.secret_refs).length>32) throw new Error('Invalid runtime environment');
  const names=[...Object.keys(r.env),...Object.keys(r.secret_refs),...Object.keys(d.bindings)];
  if (new Set(names).size!==names.length || names.some(k=>!envName.test(k)||['PORT','TZ'].includes(k))) throw new Error('Overlapping or invalid environment names');
  if (Object.entries(r.env).some(([k,v])=>/password|passwd|secret|token|credential|api.?key|private.?key|access.?key/i.test(k)||typeof v!=='string'||v.length>4096||v.includes('\0')||/:\/\/[^/\s]*@/.test(v))) throw new Error('Use secret references for credentials');
  if (Object.values(r.secret_refs).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(v))) throw new Error('Invalid secret reference');
  if (Object.values(d.bindings).some(v=>!['host','port','name','username','password','jdbc_url'].includes(v)) || (d.mode!=='postgres' && Object.keys(d.bindings).length) || (d.mode==='postgres'&&!Object.values(d.bindings).includes('password')) || (d.mode==='external'&&!Object.keys(r.secret_refs).length)) throw new Error('Invalid database bindings');
  if (!Array.isArray(r.init_command)||r.init_command.length>32||r.init_command.some(v=>typeof v!=='string'||!v||v.length>512||/[\0\n]/.test(v))||(d.mode==='none'&&r.init_command.length)) throw new Error('Invalid initialization command');
  return r;
}
export function databaseEnvironment(r, db) {
  const values={host:db.host,port:'5432',name:r.database.name,username:db.username,jdbc_url:`jdbc:postgresql://${db.host}:5432/${r.database.name}${db.ssl?'?sslmode=require':''}`};
  return Object.fromEntries(Object.entries(r.database.bindings).filter(([,v])=>v!=='password').map(([k,v])=>[k,values[v]]));
}
