import {test} from 'node:test';
import assert from 'node:assert/strict';
import {synchronizeDatabaseUrl} from '../src/database-url.js';
import {postgresUrl,databaseUrl} from '../../../packages/contracts/runtime.mjs';
import type {Config} from '../src/config.js';
import type {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';

const config={dbHost:'db.internal',dbUsername:'app',dbName:'app',dbPasswordSecretArn:'arn:password',dbUrlSecretArn:'arn:url'} as Config;
test('URL synchronization encodes password, pins versions, skips unchanged values and refreshes rotation',async()=>{
  let password='@:/?#%$ unicode한글',value='{}',writes=0;
  const client={async send(c:any){
    if(c.constructor.name==='GetSecretValueCommand')return c.input.SecretId==='arn:password'?{SecretString:JSON.stringify({password}),VersionId:'pwd-v1'}:{SecretString:value,VersionId:'url-v1'};
    assert.equal(c.constructor.name,'PutSecretValueCommand');assert.equal(c.input.SecretId,'arn:url');
    writes++;value=c.input.SecretString;return {VersionId:'url-v2'};
  }} as unknown as SecretsManagerClient;
  const r=await synchronizeDatabaseUrl(client,config,AbortSignal.timeout(1000));
  assert.equal(decodeURIComponent(new URL(value).password),password);
  assert.equal(new URL(value).searchParams.get('sslmode'),'require');
  assert.equal(r.urlReference,'arn:url:::url-v2');assert.equal(r.passwordReference,'arn:password:password::pwd-v1');
  await synchronizeDatabaseUrl(client,config,AbortSignal.timeout(1000));assert.equal(writes,1);
  password='rotated';await synchronizeDatabaseUrl(client,config,AbortSignal.timeout(1000));assert.equal(writes,2);
});
test('secret access/write failures never expose credentials',async()=>{
  const client={async send(){throw new Error('PRIVATE_PASSWORD');}} as unknown as SecretsManagerClient;
  await assert.rejects(synchronizeDatabaseUrl(client,config,AbortSignal.timeout(1000)),e=>e instanceof Error && !e.message.includes('PRIVATE_PASSWORD') && e.message.includes('synchronization failed'));
});
test('password secret can never be overwritten as the URL secret',async()=>{
  const client={async send(){assert.fail('Must fail before SDK calls');}} as unknown as SecretsManagerClient;
  await assert.rejects(synchronizeDatabaseUrl(client,{...config,dbUrlSecretArn:config.dbPasswordSecretArn},AbortSignal.timeout(1000)));
});
test('URL helper preserves percent signs and Unicode through decoding',()=>{
  for(const password of ['abc','%40','a:b@c/ d?e#f','한글$']){
    const u=new URL(postgresUrl({host:'db.internal',username:'user@name',password,name:'app',ssl:true}));
    assert.equal(decodeURIComponent(u.password),password);assert.equal(decodeURIComponent(u.username),'user@name');
  }
});

test('AWS MySQL URL requires certificate and hostname verification',()=>{
 const u=new URL(databaseUrl({mode:'mysql',host:'db.rds.amazonaws.com',username:'app',password:'@%한글',name:'app',ssl:true}));
 assert.deepEqual(JSON.parse(u.searchParams.get('ssl')!),{rejectUnauthorized:true,verifyIdentity:true});
 assert.equal(decodeURIComponent(u.password),'@%한글');
});
