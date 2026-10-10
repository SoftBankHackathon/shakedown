import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DeployRequest } from './model.js';
import type { HttpRuntime } from '../../../packages/contracts/runtime.mjs';
import { ApiError } from './model.js';

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// 이름은 AWS configSchema와 맞춘다.
export const configSchema = z.object({
  subscriptionId: guid, tenantId: guid,
  resourceGroup: z.string().regex(/^rg-shakedown-[a-z0-9-]{1,40}$/),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  containerApp: z.string().regex(/^sd-[a-z0-9-]{1,29}$/),
  repositoryUri: z.string().regex(/^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9][a-z0-9/_.-]*$/),
  publicUrl: z.url().refine(v => new URL(v).protocol === 'https:' && new URL(v).hostname.endsWith('.azurecontainerapps.io'), 'Container Apps 기본 https 주소가 필요합니다.'),
  dbHost: z.string().regex(/^[a-z0-9-]+\.postgres\.database\.azure\.com$/),
  dbName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  dbUsername: z.string().regex(/^[a-zA-Z0-9_]+$/),
  dbPasswordSecretUri: z.string().regex(/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+\/?$/),
  port: z.number().int().default(8080),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function registryServer(config: Pick<Config, 'repositoryUri'>) { return config.repositoryUri.split('/')[0]; }
export function repositoryName(config: Pick<Config, 'repositoryUri'>) { return config.repositoryUri.split('/').slice(1).join('/'); }
export function loadConfig(path: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function validateRequest(config: Config, request: DeployRequest) {
  const reject = (message: string): never => { throw new ApiError(400, message); };
  if (request.project_id !== config.projectId) reject('이 스택에 등록된 project_id만 지원합니다.');
  if (request.port !== config.port) reject('스택에 설정한 앱 포트와 일치해야 합니다.');
  if (!request.image.startsWith(config.repositoryUri + '@sha256:') || !/^sha256:[a-f0-9]{64}$/.test(request.image.split('@')[1] ?? '')) reject('허용된 ACR 저장소의 sha256 digest 이미지가 필요합니다.');
  if (request.database && request.database.name !== config.dbName) reject('미리 준비된 PostgreSQL 데이터베이스 이름을 사용하세요.');
  if (request.runtime) return validateRuntimeRequest(config, request.runtime, reject);
  for (const [key, value] of Object.entries(request.env)) {
    if (key !== 'SPRING_PROFILES_ACTIVE') reject(`지원하지 않는 환경변수: ${key}. DB 설정은 스택에서 주입합니다.`);
    if (!['demo,session-memory', 'demo,session-jdbc'].includes(value)) reject('demo,session-memory 또는 demo,session-jdbc 프로필을 사용하세요.');
  }
  for (const [key, name] of Object.entries(request.secret_refs)) {
    if (key !== 'SPRING_DATASOURCE_PASSWORD' || name !== 'db_password') reject('허용되지 않은 secret_refs입니다.');
  }
}

// 범용 런타임: 이 스택이 줄 수 있는 것만 받는다. 어댑터는 DB 비밀번호 값을 모르므로
// 비밀번호가 들어가는 URL 바인딩은 만들 수 없고, 비밀값은 Key Vault의 db_password 하나뿐이다.
export function validateRuntimeRequest(config: Config, runtime: HttpRuntime, reject: (message: string) => never) {
  if (!['none', 'postgres'].includes(runtime.database.mode)) reject('Azure 스택은 PostgreSQL(또는 DB 없음)만 지원합니다.');
  if (runtime.database.mode === 'postgres' && runtime.database.name !== config.dbName) reject('미리 준비된 PostgreSQL 데이터베이스 이름을 사용하세요.');
  if (Object.values(runtime.database.bindings).some(v => v === 'postgres_url')) reject('postgres_url 바인딩은 지원하지 않습니다. password 바인딩(또는 jdbc_url)을 사용하세요.');
  for (const name of Object.values(runtime.secret_refs)) if (name !== 'db_password') reject(`등록되지 않은 secret 참조: ${name}. Azure 스택의 비밀값은 db_password뿐입니다.`);
  if (runtime.init_command.length) reject('init_command는 아직 지원하지 않습니다. scripts/schema-init.sh로 미리 실행하세요.');
}
