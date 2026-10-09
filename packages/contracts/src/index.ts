// Shared data contracts between the deploy engine, the shakedown runner and the dashboard.
// Change these together: every package imports from here.
//
// Owners of each producer:
//   Project / Analysis      ← engine (repo analysis)
//   Deployment / TargetState ← engine (deploy orchestration)
//   Scenario / StepDiff / Report ← shakedown (AI shakedown)
// Example payloads: ../fixtures/*.json

/** Deploy targets. local and aws are implemented for the hackathon; the rest are planned. */
export type TargetName = "local" | "aws" | "onprem" | "gcp" | "azure";

export type Evidence = { field: string; value: string; file: string | null; source: "rule" | "ai" | "default" };
export type Route = { method: string; path: string; file: string; params: string[] };
export type Analysis = {
  stack: string;
  port: number;
  java_version: number | null;
  database: string | null;
  database_name: string | null;
  health_path: string;
  uses_server_session: boolean;
  summary: string;
  routes: Route[];
  evidence: Evidence[];
  env: Record<string, string>;
  secret_env: string[];
  warnings: string[];
};
export type CostLedger = { calls: number; input_tokens: number; output_tokens: number; krw: number };
export type TargetOptions = { replicas: number; sticky_sessions: boolean; tz: string };

export type Deployment = {
  id: string;
  project_id: string;
  created: number;
  finished?: number;
  status: "queued" | "building" | "deploying" | "shakedown" | "analyzing" | "fixing" | "deployed" | "warned" | "promoted" | "blocked" | "failed";
  mode?: "comparison";
  shakedown_id?: string;
  release_gate?: "passed" | "review" | "blocked";
  traffic_blocked?: boolean;
  shakedown: boolean;
  autofix: boolean;
  options: Record<string, TargetOptions>;
  image?: string;
  targets: Record<string, TargetState>;
  scenario?: Scenario;
  scenario_source?: "ai" | "saved" | "fallback";
  attempts: Attempt[];
  timings: { build_s?: number; deploy_s?: number; total_s?: number };
  ai_cost: CostLedger;
  error?: string;
};

export type Project = {
  id: string;
  name: string;
  repo: string;
  created: number;
  analysis: Analysis;
  analysis_cost: CostLedger;
  ports: Record<string, number>;
  /** Targets chosen at import. The first is the baseline the others are compared against. */
  targets?: TargetName[];
  secrets: { name: string; value: string }[];
  last_deployment?: Deployment | null;
};

export type TargetState = {
  status: "pending" | "deploying" | "ready" | "failed" | "external" | "stopped";
  label: string;
  url?: string;
  instances?: number;
  info?: Record<string, string>;
  cleanup?: "confirmed" | "failed";
  logs_collected?: boolean;
  commands?: string[];
  error?: string | null;
};

export type Step = {
  title: string;
  action: "visit" | "submit_form" | "click_link";
  path?: string | null;
  form_action?: string | null;
  link_text?: string | null;
  fields: { name: string; value: string }[];
  expect: { path_startswith?: string | null; text_contains: string[] };
};
export type Scenario = { app_understanding: string; steps: Step[] };

export type Hop = { method: string; path: string; status: number; instance: string | null };
export type StepResult = {
  index: number;
  title: string;
  status: "passed" | "failed" | "skipped";
  error: string | null;
  final_path: string | null;
  final_status: number | null;
  hops: Hop[];
  checks: { name: string; ok: boolean; detail: string }[];
  elapsed_ms: number;
};
export type StepDiff = {
  index: number;
  /** Target names compared in this row (the `local`/`cloud` fields hold baseline/candidate results). */
  baseline?: string;
  candidate?: string;
  title: string;
  local: StepResult;
  cloud: StepResult;
  kind: "same" | "env_diff" | "path_diff" | "both_failed" | "text_diff" | "skipped";
  severity: "none" | "ignore" | "warn" | "critical";
  reasons: string[];
  classified_by: "rule" | "ai";
};
export type Fix = {
  target: string;
  option: string;
  value: string;
  description: string;
  native: string;
  auto_applicable: boolean;
};
export type Report = {
  headline: string;
  cause: string;
  evidence: string[];
  fix: Fix | null;
  confidence: string;
  by: "rule" | "ai";
};
export type Attempt = {
  n: number;
  options: Record<string, TargetOptions>;
  steps?: StepDiff[];
  verdict?: { status: "PASS" | "WARN" | "BLOCKED"; first_divergence: number | null; summary: string };
  report?: Report | null;
  applied_fix?: Fix;
  duration_s?: number;
};

export type DeployEvent = { ts: number; kind: string; [k: string]: unknown };

/** Statuses after which a deployment never changes again. */
export const TERMINAL_STATUSES: ReadonlySet<Deployment["status"]> = new Set(["warned", "deployed", "promoted", "blocked", "failed"]);

/** Body of POST /api/projects (engine.yaml). */
export type CreateProjectRequest = { repo: string; name?: string; targets: TargetName[] };

/** Body of POST /api/projects/{id}/deployments — the Action button (engine.yaml). */
export type ComparisonEndpoint = { name: string; url: string };
export type CompareRequest = { baseline: ComparisonEndpoint; candidate: ComparisonEndpoint };

export type DeployRequest = {
  comparison?: ComparisonEndpoint;
  targets?: TargetName[];
  shakedown: boolean;
  autofix: boolean;
  options: Partial<Record<TargetName, Partial<TargetOptions>>>;
};


/** Target API v0.1.1 proposal — distinct from the engine's DeployRequest. */
export type TargetDeployRequest = {
  deployment_id: string;
  project_id: string;
  image: string;
  port: number;
  health_path: string;
  env?: Record<string, string>;
  secret_refs?: Record<string, string>;
  database?: { engine: "mysql" | "postgres"; name: string };
  options?: Partial<TargetOptions>;
};
export type TargetDeployment = {
  deployment_id: string;
  target: TargetName;
  status: Exclude<TargetState["status"], "external">;
  url?: string;
  instances?: number;
  started_at?: string;
  ready_at?: string;
  error?: string;
  info?: Record<string, string>;
  cleanup?: "confirmed" | "failed";
  logs_collected?: boolean;
  commands?: string[];
};
export type TargetLogLine = { ts: string; source: "deploy" | "app" | "db"; line: string };
