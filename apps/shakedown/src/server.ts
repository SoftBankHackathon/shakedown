// 엔진이 부르는 시운전 API (packages/contracts/openapi/shakedown.yaml).
// POST로 받으면 202를 바로 돌려주고 뒤에서 실행한다. 엔진은 GET으로 진행 상황과 결과를 폴링한다.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { CostLedger, Report, Scenario, StepDiff } from "@shakedown/contracts";
import { runShakedown, type ShakedownInput, type Target } from "./shakedown.ts";
import { defaultScenario } from "./scenario.ts";
import type { Verdict } from "./verdict.ts";
import { waitUntilReachable } from "./preflight.ts";
import { ruleReport } from "./report.ts";

/** GET /shakedowns/{id} 응답. 실행 중에는 verdict와 report가 없다. */
export type Shakedown = {
  shakedown_id: string;
  status: "running" | "done" | "failed";
  scenario: Scenario;
  scenario_source: "saved" | "fallback";
  steps: StepDiff[];
  verdict?: Verdict;
  /** BLOCKED일 때만 채운다. PASS/WARN이면 null. */
  report?: Report | null;
  ai_cost: CostLedger;
  error?: string;
};

type Job = Pick<ShakedownInput, "baseline" | "candidate" | "scenario">;

// 엔진은 3분 안에 done이 안 되면 실패로 본다. 보고서 작성까지 넣어도 그보다 먼저 끝내서 이유를 남긴다.
const DEFAULT_DEADLINE_MS = 150_000;
const DEFAULT_REACH_WAIT_MS = 20_000;
const ACTIONS = new Set(["visit", "submit_form", "click_link"]);
// 시나리오 하나는 수십 KB면 충분하다. 큰 본문을 끝까지 메모리에 쌓지 않게 막는다.
const MAX_BODY_BYTES = 1_000_000;

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function isTarget(value: unknown): value is Target {
  const t = value as Partial<Target> | null;
  return (
    typeof t?.name === "string" && t.name !== "" &&
    typeof t.url === "string" && /^https?:\/\//.test(t.url) && URL.canParse(t.url)
  );
}

// 단계가 0개인 시나리오는 아무것도 안 하고 PASS가 되므로 받지 않는다.
function isScenario(value: unknown): value is Scenario {
  const s = value as Partial<Scenario> | null;
  return (
    Array.isArray(s?.steps) && s.steps.length > 0 &&
    s.steps.every((step) => typeof step?.title === "string" && ACTIONS.has(step.action))
  );
}

/** 요청 본문을 검사한다. 문제가 있으면 [상태 코드, 이유]를 돌려준다. */
function parseRequest(body: unknown): Job | [number, string] {
  const b = body as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return [400, "body must be a JSON object"];
  if (typeof b.deployment_id !== "string") return [400, "deployment_id is required"];
  if (!isTarget(b.baseline)) return [400, "baseline must be {name, url} with an http(s) url"];
  if (!Array.isArray(b.candidates) || b.candidates.length === 0) return [400, "candidates must be a non-empty array"];
  if (!b.candidates.every(isTarget)) return [400, "each candidate must be {name, url} with an http(s) url"];
  if (b.candidates.length > 1) return [422, `only one candidate is supported for now (got ${b.candidates.length})`];
  // 엔진(Python)은 저장된 시나리오가 없으면 null을 보낼 수 있다 → 없는 것과 같게 본다.
  if (b.scenario != null && !isScenario(b.scenario)) return [400, "scenario must have steps with a title and a known action"];
  return { baseline: b.baseline, candidate: b.candidates[0], scenario: (b.scenario ?? undefined) as Scenario | undefined };
}

type Settings = { deadlineMs: number; reachWaitMs: number };

/** 뒤에서 시운전을 돌리고 결과를 record에 채운다. 마감 시간을 넘기면 failed로 끝낸다. */
async function run(record: Shakedown, job: Job, settings: Settings): Promise<void> {
  const { deadlineMs } = settings;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${deadlineMs / 1000}s`)), deadlineMs);
  });
  try {
    const { result, report } = await Promise.race([execute(record, job, settings), deadline]);
    record.steps = result.steps;
    record.verdict = result.verdict;
    record.report = report;
    record.status = "done";
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    record.status = "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 접속 확인 → 시운전 → 원인 보고서. 기준 환경이 닿지 않거나 시나리오를 통과하지 못하면 비교할 수 없으니 오류로 끝낸다.
 */
async function execute(record: Shakedown, job: Job, { reachWaitMs }: Settings) {
  const [baselineUp] = await Promise.all([
    waitUntilReachable(job.baseline.url, { waitMs: reachWaitMs }),
    waitUntilReachable(job.candidate.url, { waitMs: reachWaitMs }),
  ]);
  if (!baselineUp) throw new Error(`baseline ${job.baseline.name} is not reachable: ${job.baseline.url}`);

  const result = await runShakedown({
    ...job,
    // 마감 뒤에도 실행은 이어지므로, 이미 끝난 기록은 덮어쓰지 않는다.
    onProgress: (steps) => {
      if (record.status === "running") record.steps = steps;
    },
  });
  const broken = result.steps.find((d) => d.local.status !== "passed");
  if (broken) {
    if (record.status === "running") record.steps = result.steps;
    throw new Error(`baseline ${job.baseline.name} failed at step ${broken.index} (${broken.title}): ${broken.local.error ?? "no error message"}`);
  }
  const report = result.verdict.status === "BLOCKED" ? ruleReport(result.steps, result.verdict) : null;
  return { result, report };
}

export function createShakedownServer(options: { deadlineMs?: number; reachWaitMs?: number } = {}) {
  const settings: Settings = {
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    reachWaitMs: options.reachWaitMs ?? DEFAULT_REACH_WAIT_MS,
  };
  const store = new Map<string, Shakedown>();

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res.setHeader("connection", "close"), 413, { error: "invalid request", detail: "body is larger than 1MB" });
      return send(res, 400, { error: "invalid request", detail: "body must be valid JSON" });
    }
    const job = parseRequest(body);
    // 오류 모양은 target.yaml과 같은 {error, detail}. 엔진이 같은 처리 코드를 쓸 수 있다.
    if (Array.isArray(job)) return send(res, job[0], { error: job[0] === 422 ? "unsupported request" : "invalid request", detail: job[1] });

    const record: Shakedown = {
      shakedown_id: `sd_${randomBytes(5).toString("hex")}`,
      status: "running",
      scenario: job.scenario ?? defaultScenario,
      scenario_source: job.scenario ? "saved" : "fallback",
      steps: [],
      ai_cost: { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 },
    };
    store.set(record.shakedown_id, record);
    send(res, 202, record);
    void run(record, job, settings);
  }

  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/shakedowns") return create(req, res);

    const id = /^\/shakedowns\/([^/]+)$/.exec(path)?.[1];
    if (req.method === "GET" && id) {
      const record = store.get(id);
      return record ? send(res, 200, record) : send(res, 404, { error: `shakedown ${id} not found` });
    }
    send(res, 404, { error: "not found" });
  });
}
