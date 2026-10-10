// Opt-in disposable host experiment. Run prepare, reboot the host, then verify.
// Requires the repository cwd, Docker Compose and Node >=22; no public tunnel.
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {composeSpec} from '../runtime.mjs';
const [phase,dir]=process.argv.slice(2);
if(!['prepare','verify','cleanup'].includes(phase)||!dir||!path.isAbsolute(dir))throw Error('Usage: onprem-reboot.mjs prepare|verify|cleanup /absolute/private-dir');
const file=path.join(dir,'compose.json'),stateFile=path.join(dir,'state.json');
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:360000,stdio:['ignore','pipe','pipe']}).trim();
let state;
if(phase==='prepare') {
 await mkdir(dir,{recursive:true,mode:0o700});
 try {await readFile(stateFile);throw Error('Experiment already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 state={project:'sd-onprem-'+randomBytes(6).toString('hex'),image:'shakedown/onprem:'+randomBytes(6).toString('hex'),boot_id:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
 await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
} else state=JSON.parse(await readFile(stateFile,'utf8'));
const compose=args=>docker(['compose','-p',state.project,'-f',file,...args]);
const query=sql=>compose(['exec','-T','db','psql','-U','app','-d','app','-At','-c',sql]);
async function probe(){
 const address=compose(['port','app','3000']);
 for(let i=0;i<60;i++){
  try{const r=await fetch('http://'+address,{signal:AbortSignal.timeout(1000)});if(r.ok){const b=await r.json();assert.equal(b.count,2);return b;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 throw Error('HTTP/database probe failed');
}
if(phase==='prepare'){
 docker(['build','-t',state.image,'examples/http-node']);
 const runtime={version:'http-runtime.v1',port:3000,health_path:'/',env:{},secret_refs:{},database:{mode:'postgres',name:'app',bindings:{DATABASE_URL:'postgres_url'}},init_command:['node','app.mjs','--init']};
 const spec=composeSpec({image:state.image,runtime},randomBytes(24).toString('hex'));
 delete spec.services.tunnel;spec.services.app.ports=['127.0.0.1::3000'];
 await writeFile(file,JSON.stringify(spec),{mode:0o600});
 compose(['up','-d','--wait','db']);
 compose(['run','--rm','--no-deps','--entrypoint','node','app','app.mjs','--init']);
 query('INSERT INTO runtime_probe VALUES (2)');
 compose(['up','-d','app']);await probe();
 compose(['restart','app']);await probe();
 state.prepared=true;await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
 console.log(JSON.stringify({phase,app_restart_persistence:true,count:2,reboot_required:true}));
}else if(phase==='verify'){
 assert.equal(state.prepared,true);
 assert.notEqual((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),state.boot_id,'Host must actually reboot');
 const automaticallyRunning=compose(['ps','--status','running','--services']).split('\n').filter(Boolean);
 compose(['up','-d','--wait','db']);compose(['up','-d','app']);await probe();
 assert.equal(query('SELECT COUNT(*) FROM runtime_probe'),'2');
 console.log(JSON.stringify({phase,host_reboot_confirmed:true,automatically_running_services:automaticallyRunning,manual_compose_up_persistence:true,count:2,scope:'actual composeSpec with loopback app port; no tunnel or target deployment API'}));
}else{
 compose(['down','-v','--remove-orphans']);docker(['image','rm',state.image]);await rm(dir,{recursive:true});console.log(JSON.stringify({phase,cleanup:'completed'}));
}
