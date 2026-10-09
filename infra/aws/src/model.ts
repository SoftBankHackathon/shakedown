import { z } from 'zod';

export const requestSchema = z.object({
  deployment_id: z.string().regex(/^dep_[a-z0-9]{1,60}$/),
  project_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  image: z.string().max(512),
  port: z.number().int().min(1).max(65535),
  health_path: z.string().regex(/^\/(?!\/)[^\s?#\\]*$/).max(256),
  env: z.record(z.string(), z.string().max(4096)).default({}),
  secret_refs: z.record(z.string(), z.string()).default({}),
  database: z.object({ engine: z.literal('postgres'), name: z.string() }).strict().optional(),
  architecture: z.object({ version: z.literal('aws-architecture.v1'), template_id: z.enum(['small','medium','large']) }).strict().optional(),
  options: z.object({
    replicas: z.number().int().min(1).max(12).default(1),
    sticky_sessions: z.literal(false).default(false),
    tz: z.string().max(64).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }).default('UTC'),
  }).strict().prefault({}),
}).strict().refine(v => v.architecture ? v.options.replicas === ({small:1,medium:2,large:3}[v.architecture.template_id]) : v.options.replicas <= 2, 'Replicas must match the architecture or legacy limit');
export type DeployRequest = z.infer<typeof requestSchema>;
export type Deployment = {
  deployment_id: string; target: 'aws'; status: 'pending' | 'deploying' | 'ready' | 'failed';
  url?: string; instances?: number; started_at?: string; ready_at?: string;
  error?: string; info?: Record<string, string>;
};
export type LogLine = { ts: string; source: 'deploy' | 'app' | 'db'; line: string };
export type ReadyResult = { url: string; instances: number; info: Record<string, string> };
export type Log = (line: string) => void;
export interface Provider {
  validate(request: DeployRequest): void;
  deploy(request: DeployRequest, signal: AbortSignal, log: Log): Promise<ReadyResult>;
  // Must close the public route before stopping tasks; success means both confirmed.
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
