// 엔진이 부르는 시운전 API (packages/contracts/openapi/shakedown.yaml).
// POST로 받으면 202를 바로 돌려주고 뒤에서 실행한다. 엔진은 GET으로 진행 상황과 결과를 폴링한다.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { CostLedger, Report, Scenario, StepDiff } from "@shakedown/contracts";
import { runShakedown, type ShakedownInput, type Target } from "./shakedown.ts";
import { isScenario } from "./scenario.ts";
import type { Verdict } from "./verdict.ts";
import { waitUntilReachable } from "./preflight.ts";
import { LANGS, ruleReport, type Lang } from "./report.ts";
import { aiOptionsFromEnv, aiReport, noCost, type AiOptions } from "./ai-report.ts";
import { aiScenarioOptionsFromEnv } from "./ai-scenario.ts";
import { chooseScenario, type Choice } from "./choose.ts";

/** GET /shakedowns/{id} 응답. 실행 중에는 verdict와 report가 없다. */
export type Shakedown = {
  shakedown_id: string;
  status: "running" | "done" | "failed";
  /** 요청에 시나리오가 없으면 시운전이 기준 환경을 보고 고른 뒤에 채운다. 그 전 응답(202 포함)에는 없다. */
  scenario?: Scenario;
  scenario_source?: "ai" | "saved" | "fallback";
  steps: StepDiff[];
  verdict?: Verdict;
  /** BLOCKED일 때만 채운다. PASS/WARN이면 null. */
  report?: Report | null;
  ai_cost: CostLedger;
  error?: string;
};

type Job = Pick<ShakedownInput, "baseline" | "candidate" | "scenario"> & { deploymentId: string; hints?: Record<string, unknown>; lang: Lang };

// 엔진은 3분 안에 done이 안 되면 실패로 본다. 보고서 작성까지 넣어도 그보다 먼저 끝내서 이유를 남긴다.
const DEFAULT_DEADLINE_MS = 150_000;
const DEFAULT_REACH_WAIT_MS = 20_000;
// AI 보고서는 마감 전에 이만큼 여유를 두고 끝나야 한다. 남은 시간이 1초도 안 되면 부르지 않는다.
const AI_MARGIN_MS = 2_000;
const AI_MIN_MS = 1_000;
const AI_TIMEOUT_MS = 20_000;
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
  // 보고서 언어. 없거나 null이면 영어(이전 엔진과 호환).
  if (b.lang != null && !LANGS.includes(b.lang as Lang)) return [400, "lang must be ko, en or ja"];
  // hints는 엔진이 레포 분석 결과를 그대로 넘기는 자유 형식이라 모양을 검사하지 않는다.
  const hints = typeof b.hints === "object" && b.hints !== null && !Array.isArray(b.hints) ? (b.hints as Record<string, unknown>) : undefined;
  return {
    deploymentId: b.deployment_id,
    baseline: b.baseline,
    candidate: b.candidates[0],
    scenario: (b.scenario ?? undefined) as Scenario | undefined,
    hints,
    lang: (b.lang ?? "en") as Lang,
  };
}

type Settings = {
  deadlineMs: number;
  reachWaitMs: number;
  ai: AiOptions;
  aiScenario: AiOptions;
  /** 배포마다 처음 고른 시나리오. 키는 "deployment_id 기준 환경 주소 lang". 기록(store)처럼 메모리에만 둔다. */
  chosen: Map<string, Choice>;
};

// AI 시나리오 비용과 AI 보고서 비용을 합친다. 원화는 더한 뒤에도 소수 둘째 자리로 맞춘다(0.1+0.2가 0.30000000000000004가 되지 않게).
function addCost(a: CostLedger, b: CostLedger): CostLedger {
  return {
    calls: a.calls + b.calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    krw: Math.round((a.krw + b.krw) * 100) / 100,
  };
}

/** 뒤에서 시운전을 돌리고 결과를 record에 채운다. 마감 시간을 넘기면 failed로 끝낸다. */
async function run(record: Shakedown, job: Job, settings: Settings): Promise<void> {
  const { deadlineMs } = settings;
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${deadlineMs / 1000}s`);
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    const { result, report, cost } = await Promise.race([execute(record, job, settings, deadlineAt, controller.signal), deadline]);
    record.steps = result.steps;
    record.verdict = result.verdict;
    record.report = report;
    record.ai_cost = cost;
    record.status = "done";
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    record.status = "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 접속 확인 → (시나리오가 없으면) 시나리오 고르기 → 시운전 → 원인 보고서.
 * 기준 환경이 닿지 않거나 시나리오를 통과하지 못하면 비교할 수 없으니 오류로 끝낸다.
 * 보고서는 규칙으로 먼저 만들고, AI가 켜져 있으면 AI 보고서로 바꾼다(실패하면 규칙 보고서 그대로).
 */
async function execute(record: Shakedown, job: Job, { reachWaitMs, ai, aiScenario, chosen }: Settings, deadlineAt: number, signal: AbortSignal) {
  const [baselineUp] = await Promise.all([
    waitUntilReachable(job.baseline.url, { waitMs: reachWaitMs, signal }),
    waitUntilReachable(job.candidate.url, { waitMs: reachWaitMs, signal }),
  ]);
  if (!baselineUp) throw new Error(`baseline ${job.baseline.name} is not reachable: ${job.baseline.url}`);

  let scenario = job.scenario;
  let spent = noCost();
  // 엔진은 한 배포(같은 deployment_id) 안에서 비교 대상마다, 수정 적용 뒤 2회차마다 시운전을 따로 부른다.
  // 같은 배포는 같은 시나리오로 돌려야 회차끼리 맞댈 수 있다(2회차가 더 약한 둘러보기로 바뀌면 고쳐지지 않은 버그도 PASS가 된다).
  // 그래서 처음 고른 시나리오와 출처를 다시 쓰고, 이번에 부르지 않은 AI 비용은 0으로 둔다(엔진이 회차마다 더한다).
  // AI 시나리오 제목은 요청 언어로 쓰므로 언어가 다르면 따로 고른다(엔진은 한 배포에 늘 같은 lang을 보낸다).
  const key = `${job.deploymentId} ${job.baseline.url} ${job.lang}`;
  let choice: Choice | undefined;
  if (!scenario) {
    const reused = chosen.get(key);
    // 고르는 시간도 마감 안에 든다. 엔진은 폴링 때마다 scenario를 복사하고 끝나면 steps 수와 비교하므로,
    // 고른 시나리오는 단계를 돌리기 전에 기록에 채운다. AI 시나리오 비용도 이때 남겨 뒤 단계가 실패해도 보이게 한다.
    const onSpent = (cost: CostLedger) => {
      if (record.status === "running") record.ai_cost = cost;
    };
    // 고른 시나리오의 본 실행은 AI 보고서 몫을 남기고 끝나야 한다.
    const runDeadlineAt = deadlineAt - AI_TIMEOUT_MS - AI_MARGIN_MS;
    choice = reused ? { ...reused, cost: spent } : await chooseScenario(job.baseline, { hints: job.hints, lang: job.lang, ai: aiScenario, deadlineAt: runDeadlineAt, signal, onSpent });
    scenario = choice.scenario;
    spent = choice.cost;
    if (record.status === "running") {
      record.scenario = choice.scenario;
      record.scenario_source = choice.source;
      record.ai_cost = spent;
    }
  }

  const result = await runShakedown({
    ...job,
    scenario,
    signal,
    // 마감 때 HTTP 요청을 취소하고 이미 끝난 기록은 덮어쓰지 않는다.
    onProgress: (steps) => {
      if (record.status === "running") record.steps = steps;
    },
  });
  signal.throwIfAborted();
  const broken = result.steps.find((d) => d.local.status !== "passed");
  if (broken) {
    if (record.status === "running") record.steps = result.steps;
    // 다시 쓴 시나리오가 이번에 실패했으면 버린다. 붙잡고 있으면 다음 회차도 같은 자리에서 실패한다.
    if (choice) chosen.delete(key);
    throw new Error(`baseline ${job.baseline.name} failed at step ${broken.index} (${broken.title}): ${broken.local.error ?? "no error message"}`);
  }
  // 기준 환경이 끝까지 통과한 시나리오만 이 배포의 다음 시운전에 다시 쓴다.
  if (choice) chosen.set(key, choice);
  // 엔진만 이 비교 대상의 env를 바꿔 다시 배포할 수 있는지 안다. 정확히 true일 때만 자동 적용 가능으로 표시한다.
  const canApplyEnv = job.hints?.can_apply_env === true;
  const rule = result.verdict.status === "BLOCKED" ? ruleReport(result.steps, result.verdict, { canApplyEnv, lang: job.lang }) : null;
  // 이미 나온 판정을 AI 때문에 잃지 않도록, AI는 마감까지 남은 시간 안에서만 기다린다.
  const left = deadlineAt - Date.now() - AI_MARGIN_MS;
  const aiOptions = left < AI_MIN_MS ? {} : { ...ai, timeoutMs: Math.min(ai.timeoutMs ?? AI_TIMEOUT_MS, left) };
  const { report, cost } = await aiReport({ diffs: result.steps, verdict: result.verdict, fallback: rule, hints: job.hints, lang: job.lang }, aiOptions);
  return { result, report, cost: addCost(spent, cost) };
}

export function createShakedownServer(options: { deadlineMs?: number; reachWaitMs?: number; ai?: AiOptions; aiScenario?: AiOptions } = {}) {
  const settings: Settings = {
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    reachWaitMs: options.reachWaitMs ?? DEFAULT_REACH_WAIT_MS,
    ai: options.ai ?? aiOptionsFromEnv(),
    aiScenario: options.aiScenario ?? aiScenarioOptionsFromEnv(),
    chosen: new Map(),
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

    // 저장된 시나리오(saved)는 지금처럼 바로 쓴다. 없으면 기준 환경을 본 뒤에 고르므로 아직 비워 둔다.
    const record: Shakedown = {
      shakedown_id: `sd_${randomBytes(5).toString("hex")}`,
      status: "running",
      ...(job.scenario ? { scenario: job.scenario, scenario_source: "saved" as const } : {}),
      steps: [],
      ai_cost: noCost(),
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
