import { z } from 'zod';
import { validateRuntime, type HttpRuntime } from '../../../packages/contracts/runtime.mjs';
import { architectures, AZURE_ARCHITECTURE_VERSION, type Tier } from './architecture.js';

const tiers = Object.keys(architectures) as [Tier, ...Tier[]];
// 계획 없는 요청의 상한(지금처럼 2대). 계획이 있으면 등급의 시작 대수까지 받는다.
const LEGACY_MAX_REPLICAS = 2, MAX_START = Math.max(...Object.values(architectures).map(a => a.min));

export const requestSchema = z.object({
  deployment_id: z.string().regex(/^dep_[a-z0-9]{1,60}$/),
  project_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  image: z.string().max(512),
  port: z.number().int().min(1).max(65535),
  health_path: z.string().regex(/^\/(?!\/)[^\s?#\\]*$/).max(256),
  env: z.record(z.string(), z.string().max(4096)).default({}),
  secret_refs: z.record(z.string(), z.string()).default({}),
  database: z.object({ engine: z.literal('postgres'), name: z.string() }).strict().optional(),
  // 범용 HTTP 런타임(엔진이 project.runtime을 그대로 보냄). 있으면 database·secret_refs 대신 이 값을 쓴다.
  runtime: z.custom<HttpRuntime>(v => { try { validateRuntime(v); return true; } catch { return false; } }).optional(),
  // 계획 배포. AWS·GCP와 같은 모양이지만 버전은 Azure 카탈로그만 받는다. 다른 클라우드의 계획이 오면 400.
  architecture: z.object({ version: z.literal(AZURE_ARCHITECTURE_VERSION), template_id: z.enum(tiers) }).strict().optional(),
  options: z.object({
    replicas: z.number().int().min(1).max(MAX_START).default(1),
    // AWS와 달리 Azure는 ingress 세션 고정을 지원한다.
    sticky_sessions: z.boolean().default(false),
    tz: z.string().max(64).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }).default('UTC'),
  }).strict().prefault({}),
}).strict().refine(
  // 계획이 있으면 시작 대수는 등급 최소값으로 고정한다(엔진이 같은 값을 보낸다).
  v => (v.architecture ? v.options.replicas === architectures[v.architecture.template_id].min : v.options.replicas <= LEGACY_MAX_REPLICAS),
  { message: `replicas는 계획 등급의 시작 대수와 같아야 하고, 계획이 없으면 1~${LEGACY_MAX_REPLICAS}여야 합니다.`, path: ['options', 'replicas'] },
);
export type DeployRequest = z.infer<typeof requestSchema>;
export type Deployment = {
  deployment_id: string; target: 'azure'; status: 'pending' | 'deploying' | 'ready' | 'failed';
  url?: string; instances?: number; started_at?: string; ready_at?: string;
  error?: string; info?: Record<string, string>;
};
export type LogLine = { ts: string; source: 'deploy' | 'app' | 'db'; line: string };
export type ReadyResult = { url: string; instances: number; info: Record<string, string> };
export type Log = (line: string) => void;
export interface Provider {
  validate(request: DeployRequest): void;
  // 202 전에 비동기로 확인할 것 (ACR digest 존재 등). 실패는 ApiError(400).
  precheck(request: DeployRequest): Promise<void>;
  deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult>;
  // Must close the public route before deactivating the revision; success means both confirmed.
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
