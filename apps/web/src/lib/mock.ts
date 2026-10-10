// Mock engine for building the dashboard before the real engine exists.
// It replays a recorded deployment (blocked on GCP → env fix applied → promoted)
// on a timeline, so every screen state can be seen and timed for the demo.

import recorded from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json";
import project from "@shakedown/contracts/fixtures/project.json";
import {
  TERMINAL_STATUSES,
  type Attempt,
  type CreateProjectRequest,
  type DeployEvent,
  type Deployment,
  type Project,
} from "@shakedown/contracts";
import { ApiError } from "./errors";

const RECORDED = recorded as unknown as Deployment;
const PROJECT = project as unknown as Project;
const [A1, A2] = RECORDED.attempts as Attempt[];
const TARGET_NAMES = Object.keys(RECORDED.targets);
/** The target the recorded run fixed and redeployed. */
const FIXED_TARGET = A1.applied_fix?.target ?? TARGET_NAMES[TARGET_NAMES.length - 1];
// 기록은 수정이 끝난 뒤의 대상 상태라 세션 저장소가 jdbc다. 수정한 대상이 다시 배포되기 전까지는
// 수정 전처럼 메모리 세션으로 보여야 1회차(차단)와 2회차(통과)의 차이가 화면에 나타난다.
const RECORDED_FIXED = RECORDED.targets[FIXED_TARGET];
const BEFORE_FIX = RECORDED_FIXED.info?.session
  ? { ...RECORDED_FIXED, info: { ...RECORDED_FIXED.info, session: "memory" } }
  : RECORDED_FIXED;

// Timeline in seconds from the click. Tuned to feel like the real ~30 s run.
const STEP = 0.5;
const BUILT = 2;
const DEPLOYED = 5;
const SHAKEDOWN_1 = 6;
const SHAKEDOWN_1_END = SHAKEDOWN_1 + (A1.steps?.length ?? 0) * STEP;
const FIX = SHAKEDOWN_1_END + 1;
const SHAKEDOWN_2 = FIX + 3;
const SHAKEDOWN_2_END = SHAKEDOWN_2 + (A2.steps?.length ?? 0) * STEP;
/** Seconds one replay takes from click to verdict. */
const DURATION = SHAKEDOWN_2_END + 0.5;

// Deployment id → { project, start time }.
const started = new Map<string, { projectId: string; at: number }>();
const projects = new Map<string, Project>([[PROJECT.id, PROJECT]]);
let seq = 0; // keeps ids unique when two clicks land in the same millisecond

function clone<V>(v: V): V {
  return JSON.parse(JSON.stringify(v));
}

function withTargets(d: Deployment, status: (name: string) => Deployment["targets"][string]["status"], fixed = false) {
  for (const name of TARGET_NAMES) {
    const recorded = name === FIXED_TARGET && !fixed ? BEFORE_FIX : RECORDED.targets[name];
    d.targets[name] = { ...recorded, status: status(name) };
  }
}

/** What the deployment looks like `t` seconds after the click. */
function snapshot(id: string, t: number): Deployment {
  const run = started.get(id);
  const d = clone(RECORDED);
  d.id = id;
  d.project_id = run?.projectId ?? RECORDED.project_id;
  d.created = (run?.at ?? Date.now()) / 1000;

  if (t >= DURATION) {
    // The replay is shorter than the recorded run; report the replay's own duration.
    d.timings.total_s = Math.round(DURATION * 10) / 10;
    return d;
  }

  d.attempts = [];
  d.timings = {};
  d.options = clone(A1.options);
  d.scenario = undefined;
  withTargets(d, () => "pending");
  if (t < BUILT) return { ...d, status: "building" };

  d.timings.build_s = RECORDED.timings.build_s;
  if (t < DEPLOYED) {
    withTargets(d, () => "deploying");
    return { ...d, status: "deploying" };
  }
  withTargets(d, () => "ready");
  d.timings.deploy_s = RECORDED.timings.deploy_s;
  if (t < SHAKEDOWN_1) return { ...d, status: "shakedown" };

  d.scenario = RECORDED.scenario;
  const partial = (a: Attempt, since: number): Attempt => {
    const shown = Math.floor((t - since) / STEP);
    const finished = shown >= (a.steps?.length ?? 0);
    return { ...a, steps: a.steps?.slice(0, shown), verdict: finished ? a.verdict : undefined,
             report: undefined, applied_fix: undefined };
  };
  if (t < SHAKEDOWN_1_END) return { ...d, status: "shakedown", attempts: [partial(A1, SHAKEDOWN_1)] };
  if (t < FIX) return { ...d, status: "analyzing", attempts: [{ ...A1, applied_fix: undefined }] };
  if (t < SHAKEDOWN_2) {
    withTargets(d, (name) => (name === FIXED_TARGET ? "deploying" : "ready"));
    return { ...d, status: "fixing", attempts: [A1] };
  }
  d.options = RECORDED.options;
  withTargets(d, () => "ready", true);
  return { ...d, status: "shakedown", attempts: [A1, partial(A2, SHAKEDOWN_2)] };
}

const elapsed = (id: string) => (Date.now() - (started.get(id)?.at ?? 0)) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function projectFor({ repo, targets }: CreateProjectRequest): Project {
  // Last path segment of the repo, without query, hash or ".git".
  const path = repo.split(/[?#]/)[0].replace(/\.git$/, "");
  const name = path.split(/[/\\]/).filter(Boolean).pop() || PROJECT.name;
  const id = `prj_mock${[...repo].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).slice(0, 6)}`;
  const p = { ...PROJECT, id, name, repo, targets };
  projects.set(id, p);
  return p;
}

export const mockApi = {
  project: async (id: string): Promise<Project> => projects.get(id) ?? PROJECT,
  createProject: async (body: CreateProjectRequest): Promise<Project> => {
    await sleep(400); // pretend to analyze the repo
    return projectFor(body);
  },
  deployments: async (projectId?: string): Promise<Deployment[]> =>
    [...started.entries()]
      .filter(([, v]) => !projectId || v.projectId === projectId)
      .reverse()
      .map(([id]) => snapshot(id, elapsed(id))),
  // An id we never started (e.g. after a reload) shows the finished recording.
  deployment: async (id: string): Promise<Deployment> => snapshot(id, started.has(id) ? elapsed(id) : DURATION),
  deploy: async (projectId: string): Promise<Deployment> => {
    // Same rule as the engine: one running deployment per project.
    const busy = [...started.values()].some((v) => v.projectId === projectId && Date.now() < v.at + DURATION * 1000);
    if (busy) throw new ApiError("deployment already running for this project", 409);
    const id = `dep_mock${Date.now().toString(16).slice(-5)}${(seq++).toString(16)}`;
    started.set(id, { projectId, at: Date.now() });
    return snapshot(id, 0);
  },
  subscribe: (id: string, onEvent: (ev: DeployEvent) => void): (() => void) => {
    let last = "";
    const timer = setInterval(() => {
      const d = snapshot(id, started.has(id) ? elapsed(id) : DURATION);
      const key = `${d.status}:${d.attempts.map((a) => a.steps?.length ?? 0).join(",")}`;
      if (key !== last) {
        last = key;
        onEvent({ ts: Date.now() / 1000, kind: "stage", status: d.status, message: "" });
        onEvent({ ts: Date.now() / 1000, kind: "log", source: "mock", line: `status=${d.status} (mock replay)` });
      }
      if (TERMINAL_STATUSES.has(d.status)) {
        onEvent({ ts: Date.now() / 1000, kind: "done", status: d.status });
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
  },
};
