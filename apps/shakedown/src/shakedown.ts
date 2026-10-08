// 시운전 한 번: 같은 시나리오를 두 환경에서 동시에 실행하고, 비교하고, 판정한다.
import type { Scenario, StepDiff, StepResult } from "@shakedown/contracts";
import { createSession } from "./http.ts";
import { runScenario } from "./steps.ts";
import { fillStep, makeValues } from "./placeholders.ts";
import { defaultScenario } from "./scenario.ts";
import { compareSteps } from "./compare.ts";
import { judge, type Verdict } from "./verdict.ts";

export type Target = { name: string; url: string };
export type ShakedownInput = {
  baseline: Target;
  candidate: Target;
  scenario?: Scenario;
  runId?: string;
  timeoutMs?: number;
  /** 두 환경이 모두 끝낸 단계가 늘 때마다 그때까지의 비교 결과를 받는다. */
  onProgress?: (steps: StepDiff[]) => void;
};
export type ShakedownResult = {
  scenario: Scenario;
  scenario_source: "saved" | "fallback";
  steps: StepDiff[];
  verdict: Verdict;
};

export async function runShakedown(input: ShakedownInput): Promise<ShakedownResult> {
  const scenario = input.scenario ?? defaultScenario;
  const values = makeValues(input.runId);
  const steps = scenario.steps.map((s) => fillStep(s, values));
  const options = { timeoutMs: input.timeoutMs };
  const names = { baseline: input.baseline.name, candidate: input.candidate.name };

  // 한쪽만 끝낸 단계는 비교할 수 없으니, 두 쪽이 다 끝낸 단계까지만 알린다.
  const done: { base: StepResult[]; cand: StepResult[] } = { base: [], cand: [] };
  let reported = 0;
  const progress = (side: "base" | "cand") => (result: StepResult) => {
    done[side].push(result);
    const n = Math.min(done.base.length, done.cand.length);
    if (n === reported) return;
    reported = n;
    input.onProgress?.(compareSteps(done.base.slice(0, n), done.cand.slice(0, n), names));
  };

  // 브라우저 두 개처럼 세션(쿠키)을 따로 두고 동시에 실행한다.
  const [base, cand] = await Promise.all([
    runScenario(createSession(input.baseline.url, options), steps, progress("base")),
    runScenario(createSession(input.candidate.url, options), steps, progress("cand")),
  ]);
  const diffs = compareSteps(base, cand, names);
  return {
    scenario,
    scenario_source: input.scenario ? "saved" : "fallback",
    steps: diffs,
    verdict: judge(diffs),
  };
}
