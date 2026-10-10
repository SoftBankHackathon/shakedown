import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {deliveryConfig} from '../delivery.mjs';
import {composeSpec} from '../runtime.mjs';
import {directHealth} from '../probe.mjs';
const runtime={version:'http-runtime.v1',port:3000,health_path:'/',env:{},secret_refs:{},database:{mode:'none',name:'app',bindings:{}},init_command:[]};
test('direct delivery requires explicit origin, binds only app, and defaults to loopback',()=>{
 const c=deliveryConfig({LOCAL_DELIVERY_MODE:'direct',LOCAL_PUBLIC_URL:'http://192.0.2.1:18080'});
 for(const mode of ['none','postgres','mysql','mongodb']) {
  const spec=composeSpec({image:'test:app',runtime:{...runtime,database:{mode,name:'app',bindings:mode==='none'?{}:{DATABASE_URL:mode+'_url'}}}},'secret',{},c);
  assert.equal(spec.services.tunnel,undefined);assert.deepEqual(spec.services.app.ports,['127.0.0.1:18080:3000']);
  assert.equal(spec.services.app.restart,'unless-stopped');
  if(mode!=='none'){assert.equal(spec.services.db.restart,'unless-stopped');assert.equal(spec.services.db.ports,undefined);}
 }
 const legacy=composeSpec({image:'test',port:8080},'secret',{},c);
 assert.equal(legacy.services.app.restart,'unless-stopped');assert.equal(legacy.services.db.restart,'unless-stopped');
 assert.equal(composeSpec({image:'test',runtime}).services.tunnel.restart,'unless-stopped');
});
test('unsafe direct configuration fails closed',()=>{
 const base={LOCAL_DELIVERY_MODE:'direct',LOCAL_PUBLIC_URL:'http://192.0.2.1:18080'};
 for(const patch of [{LOCAL_DELIVERY_MODE:'oops'},{LOCAL_PUBLIC_URL:''},{LOCAL_PUBLIC_URL:'file:///tmp/a'},{LOCAL_PUBLIC_URL:'http://user:pass@host'},{LOCAL_PUBLIC_URL:'http://host/path'},{LOCAL_PUBLIC_URL:'http://host/?q=x'},{LOCAL_PUBLIC_URL:'http://host/#x'},{LOCAL_APP_PORT:'9101'},{LOCAL_APP_PORT:'80'},{LOCAL_APP_PORT:'x'},{LOCAL_BIND_ADDRESS:'example.com'}])assert.throws(()=>deliveryConfig({...base,...patch}));
});
test('direct readiness requires HTTP 200, refuses redirects and times out',async()=>{
 const s=http.createServer((req,res)=>{if(req.url==='/hang')return;res.writeHead(req.url==='/ok'?200:302,{location:'/ok'});res.end();});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 try {const base=`http://127.0.0.1:${s.address().port}`;assert.equal(await directHealth(base+'/ok'),true);assert.equal(await directHealth(base+'/redirect'),false);assert.equal(await directHealth(base+'/hang',50),false);}
 finally{s.closeAllConnections();await new Promise(r=>s.close(r));}
});
