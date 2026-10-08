import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { AwsProvider } from './aws-provider.js';
import { Store } from './store.js';
import { Manager } from './manager.js';
import { buildApp } from './app.js';

const path = process.env.AWS_ADAPTER_CONFIG;
if (!path) throw new Error('AWS_ADAPTER_CONFIG에 해커톤 전용 설정 파일 경로를 지정하세요.');
const config = loadConfig(path);
const dataPath = resolve(process.env.AWS_ADAPTER_DB ?? '.data/aws.sqlite3');
mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 });
// Prevent two processes from driving the same stack concurrently.
// After an unclean exit, inspect the old PID before manually removing this local lock.
const lock = dataPath + '.lock';
const fd = openSync(lock, 'wx', 0o600);
writeFileSync(fd, String(process.pid));
process.once('exit', () => { closeSync(fd); unlinkSync(lock); });
const provider = new AwsProvider(config);
await provider.verifyAccount();
const store = new Store(dataPath);
store.bindStack(JSON.stringify([config.accountId, config.projectId, config.clusterArn, config.serviceName, config.listenerArn, config.targetGroupArn]));
const manager = new Manager(store, provider);
await manager.recover();
const app = buildApp(manager);
await app.listen({ port: 9102, host: '127.0.0.1' });
console.log('AWS adapter listening on http://127.0.0.1:9102');
let closing = false;
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, async () => {
  if (closing) return; closing = true;
  await app.close(); await manager.drain(); store.close(); process.exit(0);
});
