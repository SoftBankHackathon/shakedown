// Explicit opt-in local container smoke test; no public tunnel, LLM or AWS calls.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {composeSpec} from './runtime.mjs';
const root=await mkdtemp(path.join(tmpdir(),'http-runtime-smoke-'));
const run=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:240000,stdio:['ignore','pipe','pipe']}).trim();
const results=[];
try {
 for(const language of ['node','python']) {
  const image=`shakedown/runtime-smoke:${language}-${Date.now()}`;
  run(['build','-t',image,path.resolve(`examples/http-${language}`)]);
  try {
   for(const variant of (language==='node'?['none','postgres','postgres_url']:['none','postgres'])) {
    const mode=variant==='postgres_url'?'postgres':variant;
    const id=`sd-runtime-${language}-${mode}-${Date.now()}`,file=path.join(root,id+'.json');
    const bindings=variant==='postgres_url'?{DATABASE_URL:'postgres_url'}:language==='node'?{PGHOST:'host',PGPORT:'port',PGDATABASE:'name',PGUSER:'username',PGPASSWORD:'password'}:{APP_DB_HOST:'host',APP_DB_PORT:'port',APP_DB_NAME:'name',APP_DB_USER:'username',APP_DB_PASSWORD:'password'};
    const command=language==='node'?['node','app.mjs','--init']:['python','app.py','--init'];
    const runtime={version:'http-runtime.v1',port:3000,health_path:'/',env:{},secret_refs:{},database:{mode,name:'app',bindings:mode==='postgres'?bindings:{}},init_command:mode==='postgres'?command:[]};
    const spec=composeSpec({image,runtime},'temporary@:/?#%$ 한글');
    delete spec.services.tunnel;
    spec.services.app.ports=['127.0.0.1::3000'];
    await writeFile(file,JSON.stringify(spec),{mode:0o600});
    const compose=(args)=>run(['compose','-p',id,'-f',file,...args]);
    try {
      if(mode==='postgres') {
        compose(['up','-d','--wait','db']);
        // Same entrypoint override as DockerRuntime.deploy; run twice to prove idempotence.
        for(let i=0;i<2;i++)compose(['run','--rm','--no-deps','--entrypoint',command[0],'app',...command.slice(1)]);
      }
      compose(['up','-d','app']);
      const address=compose(['port','app','3000']);
      let body;
      for(let i=0;i<50;i++) {
        try {const r=await fetch('http://'+address,{signal:AbortSignal.timeout(1000)});if(r.ok){body=await r.json();break;}}catch{}
        await new Promise(r=>setTimeout(r,200));
      }
      if(body?.language!==language || body.database!==(mode==='postgres') || body.count!==(mode==='postgres'?1:null))throw new Error('Runtime probe failed');
      results.push({language,mode,variant,http:200,migration_runs:mode==='postgres'?2:0,count:body.count});
    }finally{compose(['down','-v','--remove-orphans']);}
   }
  } finally {run(['image','rm',image]);}
 }
 console.log(JSON.stringify({results,cleanup:'completed',scope:'local composeSpec; no security-gate, public tunnel, LLM or AWS execution'},null,2));
} finally {await rm(root,{recursive:true,force:true});}
