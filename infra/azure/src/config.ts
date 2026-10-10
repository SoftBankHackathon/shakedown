import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DeployRequest } from './model.js';
import { managedDatabase, type HttpRuntime } from '../../../packages/contracts/runtime.mjs';
import { ApiError } from './model.js';

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const secretUri = z.string().regex(/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+\/?$/);
// 스택마다 DB 엔진은 하나다 (AWS와 같은 원칙: 다른 엔진은 새 스택). 엔진별 지식은 이 표에만 둔다:
// 호스트 형식(설정 검증), info 표시 이름, 서버 리소스 종류와 API 버전(main.bicep과 같은 버전).
export const DATABASE_ENGINES = {
  postgres: { host: /^[a-z0-9-]+\.postgres\.database\.azure\.com$/, label: 'Azure PostgreSQL Flexible', resource: 'Microsoft.DBforPostgreSQL/flexibleServers', apiVersion: '2024-08-01' },
  mysql: { host: /^[a-z0-9-]+\.mysql\.database\.azure\.com$/, label: 'Azure MySQL Flexible', resource: 'Microsoft.DBforMySQL/flexibleServers', apiVersion: '2024-12-30' },
  mongodb: { host: /^[a-z0-9-]+(\.global)?\.mongocluster\.cosmos\.azure\.com$/, label: 'Azure Cosmos DB for MongoDB vCore', resource: 'Microsoft.DocumentDB/mongoClusters', apiVersion: '2025-09-01' },
} as const;
export type DbEngine = keyof typeof DATABASE_ENGINES;
// Container Apps 비밀 이름 규칙 (소문자·숫자·'-', 양끝은 영숫자)
const SECRET_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// 이 이름들은 스택이 만든 비밀을 가리키므로 config.secrets로 다른 비밀에 붙일 수 없다.
const RESERVED_SECRETS = ['db_password', 'db_url'];
// 이름은 AWS configSchema와 맞춘다.
export const configSchema = z.object({
  subscriptionId: guid, tenantId: guid,
  resourceGroup: z.string().regex(/^rg-shakedown-[a-z0-9-]{1,40}$/),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  containerApp: z.string().regex(/^sd-[a-z0-9-]{1,29}$/),
  // runtime.init_command를 실행하는 Container Apps 작업. 없으면 init_command 요청을 거절한다.
  initJob: z.string().regex(/^sd-[a-z0-9-]{1,29}$/).optional(),
  repositoryUri: z.string().regex(/^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9][a-z0-9/_.-]*$/),
  publicUrl: z.url().refine(v => new URL(v).protocol === 'https:' && new URL(v).hostname.endsWith('.azurecontainerapps.io'), 'Container Apps 기본 https 주소가 필요합니다.'),
  dbEngine: z.enum(Object.keys(DATABASE_ENGINES) as [DbEngine, ...DbEngine[]]).default('postgres'),
  dbHost: z.string(),
  dbName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  dbUsername: z.string().regex(/^[a-zA-Z0-9_]+$/),
  dbPasswordSecretUri: secretUri,
  // 비밀번호가 들어간 접속 URL. Bicep이 만들어 Key Vault에만 두므로 어댑터는 값을 모른다. *_url 바인딩에 필요하다.
  dbUrlSecretUri: secretUri.optional(),
  // 외부 DB 등 앱이 secret_refs로 참조하는 추가 Key Vault 비밀: 참조 이름 → 비밀 주소 (AWS config.secrets와 같은 역할)
  secrets: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), secretUri).default({}),
  port: z.number().int().default(8080),
}).strict()
  .refine(c => DATABASE_ENGINES[c.dbEngine].host.test(c.dbHost), { message: 'dbHost가 dbEngine의 Azure 호스트 형식과 다릅니다.', path: ['dbHost'] })
  .refine(c => !RESERVED_SECRETS.some(name => name in c.secrets), { message: `secrets에 ${RESERVED_SECRETS.join('·')}는 쓸 수 없습니다 (스택의 비밀).`, path: ['secrets'] })
  // 참조 이름을 비밀 이름으로 바꿨을 때 겹치거나 규칙에 어긋나면 다른 비밀이 조용히 연결된다. 설정 단계에서 막는다.
  .refine(c => { const names = Object.keys(c.secrets).map(secretRefName); return new Set(names).size === names.length && names.every(n => SECRET_NAME.test(n)); },
    { message: 'secrets 참조 이름이 Container Apps 비밀 이름으로 바꾸면 겹치거나 규칙에 맞지 않습니다.', path: ['secrets'] });
export type Config = z.infer<typeof configSchema>;
export function registryServer(config: Pick<Config, 'repositoryUri'>) { return config.repositoryUri.split('/')[0]; }
export function repositoryName(config: Pick<Config, 'repositoryUri'>) { return config.repositoryUri.split('/').slice(1).join('/'); }
// 앱이 참조할 수 있는 모든 Key Vault 비밀: 참조 이름 → 주소
export function secretUris(config: Config): Record<string, string> {
  return { db_password: config.dbPasswordSecretUri, ...(config.dbUrlSecretUri ? { db_url: config.dbUrlSecretUri } : {}), ...config.secrets };
}
// Container Apps secret 이름은 소문자·숫자·'-'만 허용한다. 스택 비밀은 Bicep이 만든 이름 그대로 쓴다.
export function secretRefName(reference: string) {
  return RESERVED_SECRETS.includes(reference) ? reference.replace('_', '-') : 'ref-' + reference.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
export function loadConfig(path: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function validateRequest(config: Config, request: DeployRequest) {
  const reject = (message: string): never => { throw new ApiError(400, message); };
  if (request.project_id !== config.projectId) reject('이 스택에 등록된 project_id만 지원합니다.');
  if (request.port !== config.port) reject('스택에 설정한 앱 포트와 일치해야 합니다.');
  if (!request.image.startsWith(config.repositoryUri + '@sha256:') || !/^sha256:[a-f0-9]{64}$/.test(request.image.split('@')[1] ?? '')) reject('허용된 ACR 저장소의 sha256 digest 이미지가 필요합니다.');
  if (request.runtime) {
    if (request.database || Object.keys(request.env).length || Object.keys(request.secret_refs).length) reject('runtime과 기존 설정(env·secret_refs·database)을 섞을 수 없습니다.');
    return validateRuntimeRequest(config, request.runtime, reject);
  }
  // 기존(Spring 샘플) 요청은 PostgreSQL 스택 전용이다. 다른 엔진 스택은 runtime 요청만 받는다.
  if (config.dbEngine !== 'postgres') reject(`이 스택의 DB는 ${config.dbEngine}입니다. runtime을 포함한 요청만 받습니다.`);
  if (request.database && request.database.name !== config.dbName) reject('미리 준비된 PostgreSQL 데이터베이스 이름을 사용하세요.');
  for (const [key, value] of Object.entries(request.env)) {
    if (key !== 'SPRING_PROFILES_ACTIVE') reject(`지원하지 않는 환경변수: ${key}. DB 설정은 스택에서 주입합니다.`);
    if (!['demo,session-memory', 'demo,session-jdbc'].includes(value)) reject('demo,session-memory 또는 demo,session-jdbc 프로필을 사용하세요.');
  }
  for (const [key, name] of Object.entries(request.secret_refs)) {
    if (key !== 'SPRING_DATASOURCE_PASSWORD' || name !== 'db_password') reject('허용되지 않은 secret_refs입니다.');
  }
}

// 범용 런타임: 이 스택이 줄 수 있는 것만 받는다. 어댑터는 비밀값을 모르므로 모든 비밀은 Key Vault 참조로만 연결한다.
export function validateRuntimeRequest(config: Config, runtime: HttpRuntime, reject: (message: string) => never) {
  const { mode, name, bindings } = runtime.database, values = Object.values(bindings);
  if (managedDatabase(mode)) {
    if (mode !== config.dbEngine) reject(`이 스택의 DB는 ${config.dbEngine}입니다. ${mode} 프로젝트는 ${mode} 스택(provision.sh AZURE_DATABASE_ENGINE=${mode})에 배포하세요.`);
    if (name !== config.dbName) reject('미리 준비된 데이터베이스 이름을 사용하세요.');
    if (values.includes(`${mode}_url`) && !config.dbUrlSecretUri) reject('접속 URL 바인딩에는 Key Vault의 db-url 비밀이 필요합니다. provision.sh를 다시 실행해 dbUrlSecretUri를 받으세요.');
    // Cosmos DB vCore는 SRV 주소·TLS·인증 옵션이 붙은 URL 하나로 접속한다. 호스트·포트를 따로 조합한 주소는 맞지 않는다.
    if (mode === 'mongodb' && values.some(v => !['name', 'mongodb_url'].includes(v))) reject('Azure MongoDB(Cosmos DB vCore)는 mongodb_url(과 name) 바인딩만 지원합니다.');
  }
  const known = secretUris(config);
  for (const reference of Object.values(runtime.secret_refs)) if (!known[reference]) reject(`등록되지 않은 secret 참조: ${reference}. 어댑터 설정 secrets에 Key Vault 비밀 주소를 등록하세요.`);
  if (runtime.init_command.length && !config.initJob) reject('init_command를 실행할 Container Apps 작업(initJob)이 설정에 없습니다. provision.sh를 다시 실행하세요.');
}
