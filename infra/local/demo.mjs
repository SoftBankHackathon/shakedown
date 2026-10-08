import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSpec } from './runtime.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const runId = `rehearsal-${Date.now()}-${randomBytes(3).toString('hex')}`;
const project = `sd-${runId}`;
const dir = path.join(here, '.data', runId);
const composeFile = path.join(dir, 'compose.json');
const reportFile = path.join(dir, 'report.json');
const password = randomBytes(32).toString('hex');
const report = { run_id: runId, status: 'running', database: 'PostgreSQL 17', started_at: new Date().toISOString(), steps: [] };
const image = 'shakedown/kty-board:local';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let url;

async function command(program, args) {
  try {
    return (await exec(program,args,{cwd:here,timeout:240000,maxBuffer:4*1024*1024})).stdout.trim();
  } catch (error) {
    throw new Error(String(error.stderr || error.message).replaceAll(password,'[REDACTED]'));
  }
}
const compose = (...args) => command('docker',['compose','-p',project,'-f',composeFile,...args]);
async function configure(profile) {
  const spec = composeSpec({ image,port:8080,database:{engine:'postgres',name:'board_db'},env:{SPRING_PROFILES_ACTIVE:profile} },password);
  delete spec.services.tunnel;
  // Docker selects an unused loopback port. Every run owns a separate project/DB.
  spec.services.app.ports = ['127.0.0.1::8080'];
  await writeFile(composeFile,JSON.stringify(spec),{mode:0o600});
}
async function waitHealthy() {
  const port = await compose('port','app','8080');
  url = `http://${port.split('\n')[0]}`;
  const deadline = Date.now()+90000;
  while (Date.now()<deadline) {
    try {
      const response=await fetch(`${url}/health`,{signal:AbortSignal.timeout(2000)});
      await response.body?.cancel();
      if(response.status===200) return;
    } catch { /* app startup / DB reconnect */ }
    await sleep(1000);
  }
  throw new Error('App did not become healthy within 90 seconds');
}
async function smoke(marker, ...flags) {
  const output=await command('python3',[path.join(here,'smoke.py'),url,'--marker',marker,...flags]);
  return JSON.parse(output);
}
async function step(name, action) {
  console.log(`▶ ${name}`);
  const start=Date.now();
  try {
    const evidence=await action();
    report.steps.push({name,status:'passed',elapsed_ms:Date.now()-start,evidence});
    console.log(`✓ ${name}`);
  } catch(error) {
    report.steps.push({name,status:'failed',elapsed_ms:Date.now()-start,error:error.message});
    throw error;
  } finally { await writeFile(reportFile,JSON.stringify(report,null,2)); }
}

await mkdir(dir,{recursive:true,mode:0o700});
try {
  await configure('default');
  await step('Build sample image',()=>command('docker',['build','-t',image,path.resolve(here,'../../samples/kty-board')]));
  await step('Normal: create a post in PostgreSQL',async()=>{
    await compose('up','-d','--wait','--wait-timeout','90');await waitHealthy();
    return smoke('normal');
  });
  await step('Normal: post survives app restart',async()=>{
    await compose('restart','app');await waitHealthy();return smoke('normal','--verify-only');
  });
  await step('Bug: create a post with demo-reset enabled',async()=>{
    await configure('demo-reset');await compose('up','-d','app');await waitHealthy();return smoke('bug');
  });
  await step('Bug: post disappears after app restart',async()=>{
    await compose('restart','app');await waitHealthy();return smoke('bug','--verify-only','--expect-missing');
  });
  await step('Fix: switch back to normal persistence',async()=>{
    await configure('default');await compose('up','-d','app');await waitHealthy();return smoke('fixed');
  });
  await step('Fix: new post survives app restart',async()=>{
    await compose('restart','app');await waitHealthy();return smoke('fixed','--verify-only');
  });
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=error.message;process.exitCode=1;
  try { await writeFile(path.join(dir,'failure.log'),(await compose('logs','--no-color','--tail','100')).replaceAll(password,'[REDACTED]'),{mode:0o600}); } catch { /* retain the original failure */ }
  console.error(error.message);
} finally {
  try { await compose('down','--volumes','--remove-orphans');report.cleanup='passed'; }
  catch(error) {report.cleanup='failed';report.cleanup_error=error.message;process.exitCode=1;}
  report.finished_at=new Date().toISOString();
  await writeFile(reportFile,JSON.stringify(report,null,2));
  console.log(`Report: ${reportFile}`);
  console.log(`Result: ${report.status}; cleanup: ${report.cleanup}`);
}
