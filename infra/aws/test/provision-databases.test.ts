import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for(const state of ['postgres','denied','new'])test(`provision helper ${state}: engine replacement/error handling`,()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'db-provision-test-'));
 try{
  writeFileSync(path.join(dir,'aws'),`#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
 *'sts get-caller-identity'*) echo 123456789012;;
 *'cloudformation describe-stacks'*'Parameters'*)
  case "$LOOKUP" in denied) echo AccessDenied >&2;exit 1;; new) echo 'Stack does not exist' >&2;exit 1;; *) echo "$LOOKUP";;esac;;
 *'cloudformation describe-stacks'*) echo '[]';;
 *'cloudformation deploy'*) exit 0;;
 *) echo 'unexpected AWS command' >&2;exit 1;;
esac
`,{mode:0o700});
  const env={...process.env,PATH:dir+path.delimiter+process.env.PATH,CALLS:path.join(dir,'calls'),LOOKUP:state,HACKATHON_PROVISION_PROFILE:'test-profile',HACKATHON_ACCOUNT_ID:'123456789012',HACKATHON_STACK:'test-mongo',HACKATHON_DATABASE_ENGINE:'mongodb'};
  const result=spawnSync('bash',['scripts/provision.sh'],{env,encoding:'utf8'});
  const calls=readFileSync(path.join(dir,'calls'),'utf8');
  assert.equal(result.status,state==='new'?0:1,result.stderr);
  assert.equal(calls.includes('cloudformation deploy'),state==='new');
  if(state==='new'){assert.ok(calls.includes('DatabaseEngine=mongodb'));assert.ok(!calls.includes('rds describe'));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
