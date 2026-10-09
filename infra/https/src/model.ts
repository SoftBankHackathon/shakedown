import { z } from "zod";
import { parse } from "tldts";
import { domainToASCII } from "node:url";

export class HttpsError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const targetSchema = z.enum(["aws", "azure", "gcp", "local"]);
export const domainSchema = z
  .string()
  .max(253)
  .transform((v) => domainToASCII(v.trim().toLowerCase().replace(/\.$/, "")))
  .refine((v) => {
    const p = parse(v, { allowPrivateDomains: true });
    return (
      !!p.subdomain &&
      !!p.domain &&
      p.isIcann === true &&
      v
        .split(".")
        .every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
    );
  }, "app.example.com 형태의 공개 서브도메인이 필요합니다.");
export const requestSchema = z
  .object({
    domain: domainSchema,
    local_mode: z.enum(["tunnel", "caddy"]).optional(),
  })
  .strict();
export const common = {
  projectId: idSchema,
  target: targetSchema,
  internalTransport: z
    .enum(["http", "https", "unverified"])
    .default("unverified"),
  healthPath: z
    .string()
    .regex(/^\/(?!\/)[^\s#]*$/)
    .default("/"),
  // Set by the operator, never accepted in a dashboard request.
  deploymentOrigin: z.url().optional(),
  originUrl: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    );
  }),
};
const aws = z
  .object({
    ...common,
    target: z.literal("aws"),
    kind: z.literal("aws-alb"),
    profile: z
      .string()
      .min(1)
      .refine((v) => !["default", "pokeclip"].includes(v)),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().min(1),
    loadBalancerArn: z.string().startsWith("arn:aws:"),
    listenerArn: z.string().startsWith("arn:aws:"),
    targetGroupArn: z.string().startsWith("arn:aws:"),
    securityGroupId: z.string().startsWith("sg-"),
    gateRuleArn: z.string().startsWith("arn:aws:").optional(),
  })
  .strict();
const azure = {
  ...common,
  target: z.literal("azure"),
  subscriptionId: z.string().uuid(),
  tenantId: z.string().uuid(),
  resourceGroup: z.string().regex(/^[\w.-]+$/),
  name: z.string().regex(/^[\w-]+$/),
};
const aca = z
  .object({
    ...azure,
    kind: z.literal("azure-container-apps"),
    environment: z.string().regex(/^[\w-]+$/),
  })
  .strict();
const appservice = z
  .object({
    ...azure,
    kind: z.literal("azure-app-service"),
    location: z.string().regex(/^[a-z0-9]+$/),
  })
  .strict();
const gcp = z
  .object({
    ...common,
    target: z.literal("gcp"),
    kind: z.literal("gcp-alb"),
    project: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    configuration: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .refine((v) => v !== "default"),
    account: z.email(),
    urlMap: z.string().regex(/^[a-z][a-z0-9-]*$/),
    httpProxy: z.string().regex(/^[a-z][a-z0-9-]*$/),
    address: z.ipv4(),
  })
  .strict();
const tunnel = z
  .object({
    ...common,
    target: z.literal("local"),
    kind: z.literal("cloudflare-tunnel"),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    zoneId: z.string().regex(/^[a-f0-9]{32}$/),
    tunnelId: z.string().uuid(),
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  })
  .strict();
const caddy = z
  .object({
    ...common,
    target: z.literal("local"),
    kind: z.literal("caddy"),
    adminUrl: z.url().refine((v) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(v)),
    publicIp: z.ipv4(),
    email: z.email(),
  })
  .strict();
export const endpointSchema = z.discriminatedUnion("kind", [
  aws,
  aca,
  appservice,
  gcp,
  tunnel,
  caddy,
]);
export type Endpoint = z.infer<typeof endpointSchema>;
export const settingsSchema = z
  .object({
    endpoints: z.array(endpointSchema),
    statePath: z.string().default(".data/https/state.sqlite"),
  })
  .strict()
  .superRefine((s, ctx) => {
    const keys = new Set<string>();
    for (const e of s.endpoints) {
      const key =
        e.kind === "aws-alb"
          ? e.loadBalancerArn
          : e.kind === "gcp-alb"
            ? e.project + "/" + e.httpProxy
            : e.kind === "caddy"
              ? e.adminUrl
              : e.kind === "cloudflare-tunnel"
                ? e.tunnelId
                : e.subscriptionId + "/" + e.resourceGroup + "/" + e.name;
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: "HTTPS 공개 진입점은 프로젝트 전용이어야 합니다.",
        });
      keys.add(key);
    }
  });
export type Settings = z.infer<typeof settingsSchema>;
export type DnsRecord = {
  type: "CNAME" | "TXT" | "A";
  name: string;
  value: string;
  purpose: "routing" | "ownership";
  note?: string;
};
export type Status =
  | "preflight"
  | "dns_pending"
  | "certificate_pending"
  | "applying"
  | "verifying"
  | "ready"
  | "needs_action"
  | "failed";
export type Check = { name: string; ok: boolean; detail: string };
export type Binding = {
  binding_id: string;
  project_id: string;
  target: string;
  kind: Endpoint["kind"];
  domain: string;
  status: Status;
  dns_records: DnsRecord[];
  https_url?: string;
  origin_url: string;
  deployment_origin: string;
  certificate?: {
    issuer?: string;
    expires_at?: string;
    fingerprint?: string;
    renewal: "managed";
  };
  checks: Check[];
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
  traffic_blocked?: boolean | null;
  checked_at?: string;
  next_check_at: string;
  internal_transport: "http" | "https" | "unverified";
  deadline: string;
};
export type Job = {
  result: Binding;
  config: Endpoint;
  data: Record<string, any>;
  rollbackPending: boolean;
};
export type Context = { job: Job; save: () => void };
export interface Provider {
  prepare(c: Context): Promise<DnsRecord[]>;
  certificateReady(c: Context): Promise<boolean>;
  apply(c: Context): Promise<void>;
  redirect(c: Context): Promise<void>;
  rollback(c: Context): Promise<void>;
  // Used by a Target adapter during deploy/stop. No UI controls this route.
  gate?(c: Context, open: boolean): Promise<void>;
}
export function endpointFor(
  settings: Settings,
  project: string,
  target: string,
  mode?: string,
): Endpoint {
  const candidates = settings.endpoints.filter(
    (e) =>
      e.projectId === project &&
      e.target === target &&
      (target !== "local" ||
        e.kind === (mode === "caddy" ? "caddy" : "cloudflare-tunnel")),
  );
  if (candidates.length !== 1)
    throw new HttpsError(
      "RESOURCE_REQUIRED",
      "기반 리소스와 전용 계정 연결 설정이 필요합니다.",
      422,
    );
  return candidates[0];
}
