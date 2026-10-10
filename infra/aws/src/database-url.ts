import {ConnectionString} from 'mongodb-connection-string-url';
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { databaseUrl } from '../../../packages/contracts/runtime.mjs';
import type { Config } from './config.js';

// Refresh on deployment, including after DB password rotation. Use immutable
// versions in each task definition so credentials cannot change mid task launch.
export async function synchronizeDatabaseUrl(client: SecretsManagerClient, c: Config, signal: AbortSignal) {
  try {
    if (!c.dbUrlSecretArn || !c.dbPasswordSecretArn || c.dbUrlSecretArn === c.dbPasswordSecretArn) throw new Error();
    if(c.dbEngine==='mongodb') {
      const ready=await client.send(new GetSecretValueCommand({SecretId:c.dbUrlSecretArn}),{abortSignal:signal});
      const u=new ConnectionString(ready.SecretString??'');
      if(u.protocol!=='mongodb:'||JSON.stringify(u.hosts)!==JSON.stringify(c.dbHosts?.map(h=>h+':27017'))||decodeURIComponent(u.pathname.slice(1))!==c.dbName||u.searchParams.get('tls')!=='true'||u.searchParams.get('replicaSet')!=='shakedown'||u.searchParams.get('tlsCAFile')!=='/run/shakedown/db-ca/ca.pem'||u.searchParams.has('tlsAllowInvalidCertificates')||u.searchParams.has('tlsAllowInvalidHostnames')||u.searchParams.has('tlsInsecure')||!ready.VersionId||!c.dbCaSecretArn)throw new Error();
      const ca=await client.send(new GetSecretValueCommand({SecretId:c.dbCaSecretArn}),{abortSignal:signal});
      if(!ca.SecretString?.includes('-----BEGIN CERTIFICATE-----')||!ca.VersionId)throw new Error();
      return {urlReference:`${c.dbUrlSecretArn}:::${ready.VersionId}`,passwordReference:undefined,caReference:`${c.dbCaSecretArn}:::${ca.VersionId}`};
    }
    const passwordSecret = await client.send(new GetSecretValueCommand({SecretId:c.dbPasswordSecretArn}), {abortSignal:signal});
    const password = JSON.parse(passwordSecret.SecretString ?? '{}').password;
    if (typeof password !== 'string' || !password || !passwordSecret.VersionId) throw new Error();
    const url = databaseUrl({mode:c.dbEngine??'postgres',host:c.dbHost!,username:c.dbUsername!,password,name:c.dbName!,ssl:true});
    const previous = await client.send(new GetSecretValueCommand({SecretId:c.dbUrlSecretArn}), {abortSignal:signal});
    let version = previous.VersionId;
    if (previous.SecretString !== url) {
      const updated = await client.send(new PutSecretValueCommand({SecretId:c.dbUrlSecretArn,SecretString:url}), {abortSignal:signal});
      version = updated.VersionId;
    }
    if (!version) throw new Error();
    return {urlReference:`${c.dbUrlSecretArn}:::${version}`,passwordReference:`${c.dbPasswordSecretArn}:password::${passwordSecret.VersionId}`};
  } catch {
    // SDK errors can include sensitive response material. Never forward them.
    throw new Error('Database URL secret synchronization failed; check dedicated secret configuration and IAM permissions');
  }
}
