import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { architectures } from './architecture.js';
import type { DeployRequest } from './model.js';
import { ApiError } from './model.js';

const arn = z.string().startsWith('arn:aws:');
export const configSchema = z.object({
  profile: z.string().min(1).refine(v => v !== 'default', '해커톤 전용 named profile이 필요합니다.'),
  accountId: z.string().regex(/^\d{12}$/), region: z.literal('ap-northeast-2'),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  serviceName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/),
  clusterArn: arn, repository: z.string().regex(/^[a-z0-9][a-z0-9/_-]+$/),
  repositoryUri: z.string(), listenerArn: arn, gateRuleArn: arn, targetGroupArn: arn,
  publicUrl: z.url().refine(v => new URL(v).protocol === 'http:' && new URL(v).hostname.endsWith('.elb.amazonaws.com')),
  subnetIds: z.array(z.string().startsWith('subnet-')).min(2).max(3), securityGroupId: z.string().startsWith('sg-'),
  executionRoleArn: arn, taskRoleArn: arn, logGroup: z.string().startsWith('/shakedown/'),
  dbInstanceId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/).optional(),
  dbHost: z.string().regex(/^[a-zA-Z0-9.-]+$/), dbName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  dbUsername: z.string().regex(/^[a-zA-Z0-9_]+$/), dbPasswordSecretArn: arn,
  port: z.number().int().default(8080),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(path: string): Config {
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const prefix = `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/${config.repository}`;
  if (config.repositoryUri !== prefix) throw new Error('ECR repository account/region mismatch');
  for (const value of [config.clusterArn, config.listenerArn, config.gateRuleArn, config.targetGroupArn, config.executionRoleArn, config.taskRoleArn, config.dbPasswordSecretArn]) {
    if (value.split(':')[4] !== config.accountId) throw new Error('Resource ARN account mismatch');
  }
  return config;
}
export function validateRequest(config: Config, request: DeployRequest) {
  const reject = (message: string): never => { throw new ApiError(400, message); };
  if (request.architecture) {
    const spec = architectures[request.architecture.template_id];
    if (!config.dbInstanceId || new Set(config.subnetIds).size < spec.azs) reject('아키텍처 배포용 기반 스택/DB 식별자/AZ 서브넷을 먼저 준비하세요.');
    if (request.options.replicas !== spec.min) reject('태스크 수가 선택한 아키텍처와 다릅니다.');
    if (request.env.SPRING_PROFILES_ACTIVE !== 'demo,session-jdbc') reject('아키텍처 배포는 JDBC 세션 프로필이 필요합니다.');
  } else if (request.options.replicas > 2) reject('기존 배포는 최대 2개 태스크만 지원합니다.');
  if (request.project_id !== config.projectId) reject('이 스택에 등록된 project_id만 지원합니다.');
  if (request.port !== config.port) reject('스택에 설정한 앱 포트와 일치해야 합니다.');
  if (!request.image.startsWith(config.repositoryUri + '@sha256:') || !/^sha256:[a-f0-9]{64}$/.test(request.image.split('@')[1] ?? '')) reject('허용된 ECR 저장소의 sha256 digest 이미지가 필요합니다.');
  if (request.database && request.database.name !== config.dbName) reject('미리 준비된 RDS 데이터베이스 이름을 사용하세요.');
  for (const [key, value] of Object.entries(request.env)) {
    if (key !== 'SPRING_PROFILES_ACTIVE') reject(`지원하지 않는 환경변수: ${key}. DB 설정은 스택에서 주입합니다.`);
    if (!['demo,session-memory', 'demo,session-jdbc'].includes(value)) reject('demo,session-memory 또는 demo,session-jdbc 프로필을 사용하세요.');
  }
  for (const [key, name] of Object.entries(request.secret_refs)) {
    if (key !== 'SPRING_DATASOURCE_PASSWORD' || name !== 'db_password') reject('허용되지 않은 secret_refs입니다.');
  }
}
