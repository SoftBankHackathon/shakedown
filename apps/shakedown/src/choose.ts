// 요청에 시나리오가 없을 때 기준 환경을 보고 시나리오를 고른다.
// 순서: 알려진 시나리오(kty-board 기본 시나리오) → AI 시나리오 → 규칙 둘러보기. 기준 환경에서 먼저 통과한 것만 쓴다.
//   - 알려진 시나리오: 쓰기 전 단계까지만 GET으로 맞춰 본다(fits). 맞으면 지금까지처럼 그 시나리오로 돈다(데모 그대로).
//   - AI 시나리오: 둘러본 결과로 받아서 기준 환경에서만 한 번 미리 돌려 보고, 모든 단계가 통과해야 채택한다.
//   - 규칙 둘러보기: 둘러볼 때 이미 400 미만이었던 페이지만 담으므로 따로 미리 돌리지 않는다.
import type { CostLedger, Scenario } from "@shakedown/contracts";
import { createSession, type Session } from "./http.ts";
import { runScenario, runStep } from "./steps.ts";
import { findForm } from "./html.ts";
import { fillStep, makeValues } from "./placeholders.ts";
import { defaultScenario } from "./scenario.ts";
import { crawl, crawlScenario } from "./crawl.ts";
import { AI_SCENARIO_TIMEOUT_MS, aiScenario } from "./ai-scenario.ts";
import { noCost, type AiOptions } from "./ai-report.ts";
import type { Target } from "./shakedown.ts";
import type { Lang } from "./report.ts";

export type Choice = { scenario: Scenario; source: "ai" | "fallback"; cost: CostLedger };
export type ChooseOptions = {
  hints?: Record<string, unknown>;
  /** AI 시나리오의 단계 제목·app_understanding 언어. 없으면 영어. */
  lang?: Lang;
  /** AI 시나리오 설정. 비어 있으면 AI를 부르지 않는다. */
  ai: AiOptions;
  /**
   * 고른 시나리오의 본 실행까지 끝나야 하는 시각(Date.now() 기준). 시운전 마감에서 AI 보고서 몫을 뺀 시각이다(server.ts).
   * AI 시나리오를 부를 시간과 미리 돌려 볼 시간을 여기서 정한다. 없으면(CLI) 시간으로 막지 않는다.
   */
  deadlineAt?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** AI 시나리오 비용을 받자마자 알린다. 그 뒤 마감에 걸려 고르기가 예외로 끝나도 이미 청구된 비용을 기록에 남기려고 쓴다. */
  onSpent?: (cost: CostLedger) => void;
};

// AI 시나리오를 받은 뒤에는 미리 돌려 보기와 본 실행이 남는다. 본 실행은 같은 시나리오를 두 환경에서 다시 돌아 느린 쪽에 맞춰지므로
// 미리 돌려 보기의 두 배를 남긴다(아래 until). AI는 그 둘을 합해 적어도 23초(미리 돌려 보기 7.7초 이상)가 남을 때만 부른다.
const AI_RESERVE_MS = 23_000;
// 이보다 짧게 기다려서는 답을 받기 어렵다. 남은 시간이 이만큼도 안 되면 부르지 않는다.
const AI_MIN_MS = 5_000;

/**
 * 알려진 시나리오가 이 앱에 맞는지 GET으로만 본다. 첫 쓰기 단계 앞의 visit 단계들이 기준 환경에서 통과하고, 이어지는 submit_form의 폼이
 * 그 화면에 있고 그 단계가 보낼 칸이 폼에 모두 있어야 맞다(kty-board 기본 시나리오라면 GET /join 화면의 /join 폼에 email·nickname·password).
 * 쓰지 않으니 기준 환경에 흔적이 남지 않는다. 링크를 누르는 단계로 이어지면 맞는지 알 수 없어서 맞지 않는 것으로 본다.
 */
async function fits(session: Session, scenario: Scenario): Promise<boolean> {
  const values = makeValues();
  for (const [i, raw] of scenario.steps.entries()) {
    const step = fillStep(raw, values);
    if (step.action === "submit_form") {
      // 같은 /join 폼이라도 칸이 다르면(username·phone 등) 다른 앱이다. 그대로 돌리면 기준 환경에서 실패해 시운전이 failed로 끝난다.
      const form = findForm(session.lastHtml(), step.form_action ?? "");
      return form !== null && step.fields.every((f) => f.name in form.fields);
    }
    if (step.action !== "visit" || (await runStep(session, step, i + 1)).status !== "passed") return false;
  }
  return true;
}

/**
 * 기준 환경에서만 시나리오를 한 번 돌려 모든 단계가 통과하는지. 본 실행과 다른 값(runId)을 써서 가입 이메일 등이 겹치지 않는다.
 * until(시각)을 넘기면 끊고 통과하지 못한 것으로 본다. 미리 돌려 보기가 본 실행·보고서 몫까지 먹으면 마감에 걸려 판정 없이 끝나기 때문이다.
 */
async function passesOn(baseline: Target, scenario: Scenario, http: { timeoutMs?: number; signal?: AbortSignal }, until?: number): Promise<boolean> {
  if (until !== undefined && until <= Date.now()) return false;
  // AbortSignal.timeout은 0 이상의 정수만 받는다. 위 검사와 이 줄 사이에도 시계가 가므로 1ms 아래로 내려가지 않게 한다.
  const signals = [...(http.signal ? [http.signal] : []), ...(until === undefined ? [] : [AbortSignal.timeout(Math.max(1, Math.floor(until - Date.now())))])];
  const session = createSession(baseline.url, { timeoutMs: http.timeoutMs, signal: signals.length ? AbortSignal.any(signals) : undefined });
  const values = makeValues();
  const results = await runScenario(session, scenario.steps.map((s) => fillStep(s, values)));
  return results.every((r) => r.status === "passed");
}

/** 시나리오를 고른다. 기준 환경에서 열리는 페이지가 하나도 없으면 비교할 것이 없으니 예외를 던진다. */
export async function chooseScenario(baseline: Target, options: ChooseOptions): Promise<Choice> {
  const { signal } = options;
  const http = { timeoutMs: options.timeoutMs, signal };
  let cost = noCost();

  if (await fits(createSession(baseline.url, http), defaultScenario)) return { scenario: defaultScenario, source: "fallback", cost };
  signal?.throwIfAborted();

  const pages = await crawl(baseline.url, { healthPath: options.hints?.health_path, ...http });
  signal?.throwIfAborted();
  const rule = crawlScenario(pages);
  // 열리는 페이지가 없으면 AI에게 줄 재료도 없다. AI를 부르기 전에 끝낸다.
  if (!rule) {
    const tried = pages.map((p) => `${p.path} ${p.status !== null ? `HTTP ${p.status}` : p.error}`).join(", ");
    throw new Error(`baseline ${baseline.name} has no page to compare: ${tried || "nothing could be opened"}`);
  }

  const left = (options.deadlineAt ?? Infinity) - Date.now() - AI_RESERVE_MS;
  if (left >= AI_MIN_MS) {
    const ai = await aiScenario({ pages, hints: options.hints, lang: options.lang }, { ...options.ai, timeoutMs: Math.min(options.ai.timeoutMs ?? AI_SCENARIO_TIMEOUT_MS, left), signal });
    cost = ai.cost;
    options.onSpent?.(cost);
    signal?.throwIfAborted();
    // 남은 시간의 3분의 1까지만 미리 돌리고 3분의 2는 본 실행 몫으로 남긴다.
    const until = options.deadlineAt === undefined ? undefined : Date.now() + (options.deadlineAt - Date.now()) / 3;
    if (ai.scenario && (await passesOn(baseline, ai.scenario, http, until))) return { scenario: ai.scenario, source: "ai", cost };
    signal?.throwIfAborted();
  }
  return { scenario: rule, source: "fallback", cost };
}
