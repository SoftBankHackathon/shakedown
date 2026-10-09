import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, validate } from '../server.mjs';
import { composeSpec, DockerRuntime } from '../runtime.mjs';

const request = { deployment_id:'dep_test1',project_id:'prj_test',image:'board:test',port:8080,health_path:'/health',database:{engine:'postgres',name:'board_db'} };
async function fixture(t, runtime) {
  const root = await mkdtemp(path.join(os.tmpdir(),'shakedown-local-'));
  const service = await createService({root,runtime});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await service.settle();await new Promise(resolve=>service.server.close(resolve));await rm(root,{recursive:true,force:true});});
  const api = async (method, route, body) => fetch(`http://127.0.0.1:${service.server.address().port}${route}`, {method,headers:{'Content-Type':'application/json'},body:body && JSON.stringify(body)});
  return {api,service,root};
}
test('PG compose uses consistent credentials, literal dollar signs, and private DB',()=>{
  const spec = composeSpec({...request,env:{SPRING_DATASOURCE_URL:'jdbc:mysql://wrong/db',TOKEN:'a$b'}},'p$a');
  assert.equal(spec.services.app.environment.SPRING_DATASOURCE_URL,'jdbc:postgresql://db:5432/board_db');
  assert.equal(spec.services.db.environment.POSTGRES_PASSWORD,'p$$a');
  assert.equal(spec.services.app.environment.TOKEN,'a$$b');
  assert.equal(spec.services.db.ports,undefined);
  assert.equal(spec.services.app.ports,undefined);
});
test('validation rejects malformed input and unsupported DB',()=>{
  for (const patch of [{deployment_id:'../evil'},{image:'--privileged'},{port:0},{health_path:'//elsewhere'},{database:{engine:'mysql'}},{env:[]},{options:{replicas:0}},{options:{tz:'bad-zone'}}]) assert.throws(()=>validate({...request,...patch}));
  assert.doesNotThrow(()=>validate(request));
});
test('secret references resolve locally and are redacted',()=>{
  const runtime = new DockerRuntime('/tmp',{password:'private-secret'});
  assert.equal(runtime.resolved({secret_refs:{X:'db_password'}}).X,'private-secret');
  assert.equal(runtime.redact('password private-secret'),'password [REDACTED]');
  assert.throws(()=>runtime.validate({...request,secret_refs:{X:'missing'}}));
});
test('async deployment, idempotency, project conflict, logs, delete',async t=>{
  let release, calls=0, removed=0;
  const gate = new Promise(resolve=>release=resolve);
  const {api,service} = await fixture(t,{
    async deploy(input,log){calls++;log('launch');await gate;return {url:'https://example.trycloudflare.com',instances:1};},
    async remove(){removed++;},async logs(){return [{ts:'2026-10-08T00:00:00Z',source:'app',line:'ok'}];}
  });
  assert.equal((await api('POST','/deployments',request)).status,202);
  assert.equal((await api('POST','/deployments',request)).status,202);
  assert.equal((await api('POST','/deployments',{...request,deployment_id:'dep_other'})).status,409);
  assert.equal((await (await api('GET','/deployments/dep_test1')).json()).status,'deploying');
  release(); await service.settle();
  assert.equal(calls,1);
  assert.equal((await api('POST','/deployments',{...request,port:9000})).status,409);
  const state=await (await api('GET','/deployments/dep_test1')).json();
  assert.equal(state.status,'ready');assert.match(state.url,/^https:/);
  assert.equal((await api('GET','/deployments/dep_test1/logs?since=no')).status,400);
  assert.ok((await (await api('GET','/deployments/dep_test1/logs')).json()).lines.length>=2);
  assert.equal((await api('DELETE','/deployments/dep_test1')).status,204);assert.equal(removed,1);
  assert.equal((await api('GET','/deployments/dep_test1')).status,404);
  assert.equal((await api('DELETE','/deployments/dep_test1')).status,204);
  assert.equal((await api('POST','/deployments',request)).status,409);
  assert.equal((await api('GET','/deployments/dep_test1/logs')).status,200);
});
test('failure is queryable and state survives service recreation',async t=>{
  const runtime={async deploy(){throw new Error('unhealthy');},async logs(){return [];}};
  const {api,service,root}=await fixture(t,runtime);
  await api('POST','/deployments',request);await service.settle();
  assert.equal((await (await api('GET','/deployments/dep_test1')).json()).error,'unhealthy');
  const restarted=await createService({root,runtime});
  await new Promise(resolve=>restarted.server.listen(0,'127.0.0.1',resolve));
  const response=await fetch(`http://127.0.0.1:${restarted.server.address().port}/deployments/dep_test1`);
  assert.equal((await response.json()).status,'failed');
  await new Promise(resolve=>restarted.server.close(resolve));
});
test('delete during deploy waits for startup before removing resources',async t=>{
  let release, removed = false;
  const gate = new Promise(resolve=>release=resolve);
  const {api,service}=await fixture(t,{
    async deploy(){await gate;return {url:'https://example.trycloudflare.com'};},
    async remove(){removed=true;},async logs(){return [];}
  });
  await api('POST','/deployments',request);
  const deletion=api('DELETE','/deployments/dep_test1');
  assert.equal(removed,false);
  release();await service.settle();
  assert.equal((await deletion).status,204);
  assert.equal(removed,true);
  assert.equal((await api('GET','/deployments/dep_test1')).status,404);
  assert.equal((await api('DELETE','/deployments/dep_test1')).status,204);
  assert.equal((await api('POST','/deployments',request)).status,409);
  assert.equal((await api('GET','/deployments/dep_test1/logs')).status,200);
});
test('invalid requests and unknown secret refs never start Docker',async t=>{
  const {api}=await fixture(t,{validate(){throw new Error('Unknown secret reference');},deploy(){assert.fail('must not deploy');}});
  assert.equal((await api('POST','/deployments',{...request,port:0})).status,400);
  assert.equal((await api('POST','/deployments',request)).status,400);
  assert.equal((await api('GET','/deployments/dep_test1')).status,404);
});

test('generic HTTP app without DB has no database, secret or Spring dependency',()=>{
  const runtime={version:'http-runtime.v1',port:3000,health_path:'/health',env:{NODE_ENV:'production'},secret_refs:{},database:{mode:'none',name:'app',bindings:{}},init_command:[]};
  const request={deployment_id:'dep_generic',project_id:'test',image:'test:app',port:3000,health_path:'/health',runtime};
  validate(request);
  new DockerRuntime('/tmp/unused').validate(request);
  const spec=composeSpec(request);
  assert.equal(spec.services.db,undefined);assert.equal(spec.volumes,undefined);
  assert.equal(spec.services.app.environment.PORT,'3000');
  assert.ok(!Object.keys(spec.services.app.environment).some(k=>k.startsWith('SPRING')));
});

test('generic PostgreSQL binds app-specific names and excludes secrets from plain environment contract',()=>{
  const runtime={version:'http-runtime.v1',port:8000,health_path:'/',env:{},secret_refs:{},database:{mode:'postgres',name:'app',bindings:{CUSTOM_HOST:'host',CUSTOM_PASS:'password',PGUSER:'username'}},init_command:['python','migrate.py']};
  const request={deployment_id:'dep_generic',project_id:'test',image:'test:app',port:8000,health_path:'/',runtime};
  validate(request);
  const spec=composeSpec(request,'p$a');
  assert.equal(spec.services.app.environment.CUSTOM_PASS,'p$$a');
  assert.equal(spec.services.app.environment.CUSTOM_HOST,'db');
  assert.equal(spec.services.db.environment.POSTGRES_USER,'app');
  assert.ok(!Object.keys(spec.services.app.environment).some(k=>k.startsWith('SPRING')));
  assert.throws(()=>validate({...request,runtime:{...runtime,secret_refs:{CUSTOM_HOST:'bad'}}}));
});
