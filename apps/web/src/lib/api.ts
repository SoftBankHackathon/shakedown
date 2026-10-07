import {
  TERMINAL_STATUSES,
  type CreateProjectRequest,
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
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError(body.detail ?? `HTTP ${r.status}`, r.status);
  }
  return r.json();
}

const liveApi = {
  project: (id: string) => call<Project>(`/api/projects/${id}`),
  createProject: (body: CreateProjectRequest) =>
    call<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  deployments: (projectId: string) => call<Deployment[]>(`/api/deployments?project_id=${projectId}`),
  deployment: (id: string) => call<Deployment>(`/api/deployments/${id}`),
  deploy: (projectId: string, body: DeployRequest) =>
    call<Deployment>(`/api/projects/${projectId}/deployments`, { method: "POST", body: JSON.stringify(body) }),
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

export const api: typeof liveApi = MOCK ? mockApi : liveApi;

export const DONE = TERMINAL_STATUSES;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60).toString().padStart(2, "0")}s`;
}
