import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { AzureClient } from './azure-client.js';
import { AzureProvider } from './azure-provider.js';
import { Store } from './store.js';
import { Manager } from './manager.js';
import { buildApp } from './app.js';

const config = loadConfig(resolve(process.env.AZURE_ADAPTER_CONFIG ?? '.data/azure/config.json'));
const dataPath = resolve(process.env.AZURE_ADAPTER_DB ?? '.data/azure.sqlite3');
mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 });
// 같은 Container App을 두 프로세스가 동시에 바꾸지 못하게 한다.
// 비정상 종료 후에는 남은 PID를 확인하고 이 잠금 파일을 직접 지운다.
const lock = dataPath + '.lock';
const fd = openSync(lock, 'wx', 0o600);
writeFileSync(fd, String(process.pid));
process.once('exit', () => { closeSync(fd); unlinkSync(lock); });
const provider = new AzureProvider(config, new AzureClient(config));
await provider.verifySubscription();
await provider.verifyDatabase();
const store = new Store(dataPath);
store.bindStack(JSON.stringify([config.subscriptionId, config.projectId, config.resourceGroup, config.containerApp, config.repositoryUri]));
const manager = new Manager(store, provider);
await manager.recover();
const app = buildApp(manager);
await app.listen({ port: 9104, host: '127.0.0.1' });
console.log('Azure adapter listening on http://127.0.0.1:9104');
let closing = false;
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, async () => {
  if (closing) return; closing = true;
  await app.close(); await manager.drain(); store.close(); process.exit(0);
});
