import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DeployRequest } from './model.js';
import { ApiError } from './model.js';

export const configSchema = z.object({
  gcpProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),      // shakedown-511106
  gcpProjectNumber: z.string().regex(/^\d{6,20}$/),                     // 700410260240
  region: z.literal('asia-northeast3'),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),                 // 엔진의 prj_… (등록 후 채움)
  serviceName: z.string().regex(/^[a-z][a-z0-9-]{0,47}[a-z0-9]$/),      // shakedown-board
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,47}[a-z0-9]$/),          // shakedown-board-schema
  imagePrefixes: z.array(z.string().min(1)).min(1),                      // ['asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/']
  network: z.string().min(1), subnetwork: z.string().min(1),             // default, default
  dbHost: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/),                  // 사설 IP
  dbName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  dbUsername: z.string().regex(/^[a-zA-Z0-9_]+$/),
  dbPasswordSecret: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),           // Secret Manager 이름(버전 latest)
  port: z.number().int().min(1).max(65535).default(8080),
  memory: z.string().default('1Gi'), cpu: z.string().default('1'),
}).strict();
export type Config = z.infer<typeof configSchema>;

// 저장소·이미지 경로 한 칸의 모양. OCI distribution 명세의 이름 규칙(소문자·숫자, 사이에 . _ __ -)을 그대로 옮겼다.
const part = '[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*';
const repositoryPath = new RegExp(`^(?:${part}/)+$`);                         // 'shakedown/' — 저장소 경로, '/'로 끝남
const imageWithDigest = new RegExp(`^${part}(?:/${part})*@sha256:[a-f0-9]{64}$`); // 'shakedown-board@sha256:<64자>'

// egress를 PRIVATE_RANGES_ONLY로 두면 사설 주소로 가는 트래픽만 VPC로 가고 나머지는 인터넷으로 나간다.
// Cloud Run 문서가 사설 대역으로 꼽는 것은 RFC 1918과 RFC 6598이다. DB 주소가 그 밖이면 앱이 DB를 못 찾아
// 270초를 다 쓰고 실패하므로, 설정을 읽는 순간 막는다.
function isPrivateIpv4(host: string): boolean {
  const [a, b, c, d] = host.split('.').map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function loadConfig(path: string): Config {
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  // 이미지는 이 프로젝트·리전의 Artifact Registry에서만 받는다(Docker Hub도 같은 곳의 원격 저장소로 거친다).
  // 접두어가 '/'로 끝나지 않으면 '.../shakedown'이 '.../shakedown-evil/...'까지 통과시키므로 저장소 경계를 '/'로 못 박는다.
  const registry = `${config.region}-docker.pkg.dev/${config.gcpProject}/`;
  for (const prefix of config.imagePrefixes) {
    if (!prefix.endsWith('/')) throw new Error(`imagePrefixes entry must end with "/": ${prefix}`);
    if (!prefix.startsWith(registry) || !repositoryPath.test(prefix.slice(registry.length))) throw new Error(`imagePrefixes entry must be an Artifact Registry repository under ${registry}: ${prefix}`);
  }
  if (!isPrivateIpv4(config.dbHost)) throw new Error('dbHost must be a private IPv4 address (RFC 1918 or RFC 6598) reachable through Direct VPC egress');
  return config;
}

export function validateRequest(config: Config, request: DeployRequest) {
  const reject = (message: string): never => { throw new ApiError(400, message); };
  if (request.project_id !== config.projectId) reject('이 서비스에 등록된 project_id만 지원합니다.');
  if (request.port !== config.port) reject('설정한 앱 포트와 일치해야 합니다.');
  // 태그(:latest)는 push할 때마다 가리키는 이미지가 바뀐다. Local과 GCP가 같은 이미지를 돌린다고 말하려면 digest만 받아야 한다.
  if (!config.imagePrefixes.some(prefix => request.image.startsWith(prefix) && imageWithDigest.test(request.image.slice(prefix.length)))) reject('허용된 Artifact Registry 저장소의 sha256 digest 이미지가 필요합니다.');
  if (request.database && request.database.name !== config.dbName) reject('미리 준비된 Cloud SQL 데이터베이스 이름을 사용하세요.');
  for (const [key, value] of Object.entries(request.env)) {
    if (key !== 'SPRING_PROFILES_ACTIVE') reject(`지원하지 않는 환경변수: ${key}. DB 설정은 어댑터가 주입합니다.`);
    if (!['demo,session-memory', 'demo,session-jdbc'].includes(value)) reject('demo,session-memory 또는 demo,session-jdbc 프로필을 사용하세요.');
  }
  for (const [key, name] of Object.entries(request.secret_refs)) {
    if (key !== 'SPRING_DATASOURCE_PASSWORD' || name !== 'db_password') reject('허용되지 않은 secret_refs입니다.');
  }
}
