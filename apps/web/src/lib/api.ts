import {
  TERMINAL_STATUSES,
  type CreateProjectRequest,
  type CompareRequest,
  type DeployEvent,
  type DeployRequest,
  type Deployment,
  type Project,
} from "@shakedown/contracts";
import { ApiError } from "./errors";
import { mockApi } from "./mock";

export type * from "@shakedown/contracts";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "";
/** Without an engine URL the dashboard runs on recorded fixtures, so it can be built before the engine exists. */
export const MOCK = !API;

export { ApiError };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError(body.detail ?? `HTTP ${r.status}`, r.status);
  }
  return r.json();
}

const liveApi = {
  /** Every registered project, newest first as the engine stores them. */
  projects: () => call<Project[]>("/api/projects"),
  project: (id: string) => call<Project>(`/api/projects/${id}`),
  /** Every deployment the engine knows, across projects. */
  allDeployments: () => call<Deployment[]>("/api/deployments"),
  health: () => call<{ ok: boolean }>("/api/health"),
  createProject: (body: CreateProjectRequest) =>
    call<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  deployments: (projectId: string) => call<Deployment[]>(`/api/deployments?project_id=${projectId}`),
  deployment: (id: string) => call<Deployment>(`/api/deployments/${id}`),
  deploy: (projectId: string, body: DeployRequest) =>
    call<Deployment>(`/api/projects/${projectId}/deployments`, { method: "POST", body: JSON.stringify(body) }),
  compare: (projectId: string, body: CompareRequest) =>
    call<Deployment>(`/api/projects/${projectId}/comparisons`, { method: "POST", body: JSON.stringify(body) }),
  /** 차단된 배포에 원인 보고서의 수정안을 적용하고 다시 시운전한다(engine.yaml applyFix). 202 응답은 status=fixing. */
  applyFix: (id: string) => call<Deployment>(`/api/deployments/${id}/fix`, { method: "POST" }),
  /** Live progress over SSE. Returns an unsubscribe function. */
  subscribe: (id: string, onEvent: (ev: DeployEvent) => void): (() => void) => {
    const es = new EventSource(`${API}/api/deployments/${id}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as DeployEvent;
      onEvent(ev);
      if (ev.kind === "done") es.close();
    };
    return () => es.close();
  },
};

// mock 재생은 blocked에서 멈추지 않고 수정·2회차까지 저절로 가므로 수정 적용 버튼이 나오지 않는다.
export const api: typeof liveApi = MOCK ? {
  ...mockApi,
  projects: async () => [await mockApi.project("")],
  allDeployments: () => mockApi.deployments(),
  health: async () => ({ ok: true }),
  compare: async () => { throw new Error("Use live mode to compare existing environments."); },
  applyFix: async () => { throw new Error("Use live mode to apply a fix."); },
} : liveApi;

export const DONE = TERMINAL_STATUSES;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60).toString().padStart(2, "0")}s`;
}
