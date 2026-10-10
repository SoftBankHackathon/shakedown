import { z } from 'zod';
import { architectures, GCP_ARCHITECTURE_VERSION } from './architecture.js';

// infra/aws/src/model.ts에서 가져왔다. 엔진은 Local·AWS·GCP에 같은 요청 모양을 보내므로 이름과 모양은 그대로 두고,
// GCP에서 동작이 달라지는 곳(target 이름, sticky_sessions 허용, 계획 카탈로그 버전)만 바꿨다.
export const requestSchema = z.object({
  deployment_id: z.string().regex(/^dep_[a-z0-9]{1,60}$/),
  project_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  image: z.string().max(512),
  port: z.number().int().min(1).max(65535),
  health_path: z.string().regex(/^\/(?!\/)[^\s?#\\]*$/).max(256),
  env: z.record(z.string(), z.string().max(4096)).default({}),
  secret_refs: z.record(z.string(), z.string()).default({}),
  database: z.object({ engine: z.literal('postgres'), name: z.string() }).strict().optional(),
  // 계획 배포. AWS와 같은 모양이지만 버전은 GCP 카탈로그만 받는다. 다른 클라우드의 계획이 잘못 오면 400으로 막힌다.
  architecture: z.object({ version: z.literal(GCP_ARCHITECTURE_VERSION), template_id: z.enum(['small', 'medium', 'large']) }).strict().optional(),
  options: z.object({
    // 상한 3은 계획 배포(large 시작 3대) 때문이다. 계획 없는 요청은 아래 refine이 지금처럼 2대까지만 받는다.
    replicas: z.number().int().min(1).max(3).default(1),
    // Cloud Run은 세션 어피니티(template.sessionAffinity)가 있어서 true도 받는다. 같은 서버로 보내는 건 best-effort다.
    sticky_sessions: z.boolean().default(false),
    tz: z.string().max(64).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }).default('UTC'),
  }).strict().prefault({}),
}).strict().refine(
  // 계획이 있으면 시작 대수는 등급 최소값으로 고정한다(엔진이 같은 값을 보낸다). 다른 값을 받으면 카탈로그와 다른 범위로 뜬다.
  v => (v.architecture ? v.options.replicas === architectures[v.architecture.template_id].min : v.options.replicas <= 2),
  { message: 'replicas는 계획 등급의 최소 대수(small 1, medium 2, large 3)와 같아야 하고, 계획이 없으면 1~2여야 합니다.', path: ['options', 'replicas'] },
);
export type DeployRequest = z.infer<typeof requestSchema>;
export type Deployment = {
  deployment_id: string; target: 'gcp'; status: 'pending' | 'deploying' | 'ready' | 'failed';
  url?: string; instances?: number; started_at?: string; ready_at?: string;
  error?: string; info?: Record<string, string>;
};
export type LogLine = { ts: string; source: 'deploy' | 'app' | 'db'; line: string };
export type ReadyResult = { url: string; instances: number; info: Record<string, string> };
export type Log = (line: string) => void;
export interface Provider {
  validate(request: DeployRequest): void;
  deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult>;
  // 성공은 "서버 0대 + 공개 주소가 4xx·5xx를 줌(2xx·3xx는 앱이 아직 답한다는 뜻)"을 둘 다 확인했다는 뜻이다.
  // allUsers 권한 회수는 반영에 보통 2분, 길면 7분 넘게 걸려 엔진의 DELETE 제한(20초)을 넘으므로 기다리지 않는다.
  stop(log: Log): Promise<void>;
  appLogs(deploymentId: string, since?: string): Promise<LogLine[]>;
}
export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export function redact(value: string): string {
  return value
    .replace(/(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '$1=[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}
