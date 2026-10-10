import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { postgresUrl } from '../../../packages/contracts/runtime.mjs';
import type { Config } from './config.js';

// Refresh on deployment, including after DB password rotation. Use immutable
// versions in each task definition so credentials cannot change mid task launch.
export async function synchronizeDatabaseUrl(client: SecretsManagerClient, c: Config, signal: AbortSignal) {
  try {
    if (!c.dbUrlSecretArn || !c.dbPasswordSecretArn || c.dbUrlSecretArn === c.dbPasswordSecretArn) throw new Error();
    const passwordSecret = await client.send(new GetSecretValueCommand({SecretId:c.dbPasswordSecretArn}), {abortSignal:signal});
    const password = JSON.parse(passwordSecret.SecretString ?? '{}').password;
    if (typeof password !== 'string' || !password || !passwordSecret.VersionId) throw new Error();
    const url = postgresUrl({host:c.dbHost!,username:c.dbUsername!,password,name:c.dbName!,ssl:true});
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
    throw new Error('PostgreSQL URL secret synchronization failed; check dedicated secret configuration and IAM permissions');
  }
}
