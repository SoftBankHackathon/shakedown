// GCP 배포 API 진입점. 엔진만 부르도록 127.0.0.1:9103에만 연다.
// 실행: GCP_ADAPTER_CONFIG=<설정 파일 절대 경로> npm run dev:gcp
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { googleHttp } from './gcp-http.js';
import { CloudRun } from './cloud-run.js';
import { GcpProvider, READY_TIMEOUT_MS } from './gcp-provider.js';
import { Store } from './store.js';
import { Manager } from './manager.js';
import { buildApp } from './app.js';

const path = process.env.GCP_ADAPTER_CONFIG;
if (!path) throw new Error('GCP_ADAPTER_CONFIG에 해커톤 전용 설정 파일 경로를 지정하세요.');
const config = loadConfig(path);
const dataPath = resolve(process.env.GCP_ADAPTER_DB ?? '.data/gcp.sqlite3');
mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 });
// 두 프로세스가 같은 Cloud Run 서비스를 동시에 움직이면 대수·권한이 서로 덮인다. 파일 하나로 막는다.
// 비정상 종료로 잠금 파일이 남으면, 안에 적힌 PID가 끝났는지 확인한 뒤에만 손으로 지운다.
const lock = dataPath + '.lock';
let fd: number;
try { fd = openSync(lock, 'wx', 0o600); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  throw new Error(`잠금 파일 ${lock}이 있습니다. 다른 GCP 배포 API가 켜져 있는지 보고, 안에 적힌 PID가 끝났으면 파일을 지운 뒤 다시 실행하세요.`);
}
writeFileSync(fd, String(process.pid));
process.once('exit', () => { closeSync(fd); unlinkSync(lock); });
// 사용자 로그인(ADC)으로 부르므로 요금·한도를 매길 프로젝트를 헤더로 못 박는다.
const provider = new GcpProvider(config, new CloudRun(googleHttp(config.gcpProject), config));
// 다른 프로젝트로 로그인돼 있으면 어떤 자원도 바꾸기 전에 여기서 멈춘다.
await provider.verifyProject();
const store = new Store(dataPath);
// 같은 상태 DB를 다른 프로젝트·서비스 설정으로 열면 엉뚱한 서비스를 내릴 수 있어 거부한다.
store.bindStack(JSON.stringify([config.gcpProject, config.region, config.serviceName, config.jobName, config.projectId]));
// Cloud Run이 인스턴스를 늦게 잡는 날이 있어 AWS와 같은 270초 대신 420초를 준다(이유는 READY_TIMEOUT_MS 주석).
const manager = new Manager(store, provider, READY_TIMEOUT_MS);
// 포트를 열기 전에 끊긴 배포를 닫아야 엔진이 반쯤 된 상태를 ready로 보지 않는다.
await manager.recover();
const app = buildApp(manager);
await app.listen({ port: 9103, host: '127.0.0.1' });
console.log('GCP adapter listening on http://127.0.0.1:9103');
let closing = false;
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, async () => {
  if (closing) return; closing = true;
  // 진행 중인 배포가 끝나야 상태 DB에 결과가 남는다. 뒤에서 도는 공개 권한 제거도 끝나야 allUsers가 남지 않는다. 그다음 DB를 닫는다.
  await app.close(); await manager.drain(); await provider.settled(); store.close(); process.exit(0);
});
