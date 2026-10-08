// 시운전 한 번: 같은 시나리오를 두 환경에서 동시에 실행하고, 비교하고, 판정한다.
import type { Scenario, StepDiff } from "@shakedown/contracts";
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

  // 브라우저 두 개처럼 세션(쿠키)을 따로 두고 동시에 실행한다.
  const [base, cand] = await Promise.all([
    runScenario(createSession(input.baseline.url, options), steps),
    runScenario(createSession(input.candidate.url, options), steps),
  ]);
  const diffs = compareSteps(base, cand, { baseline: input.baseline.name, candidate: input.candidate.name });
  return {
    scenario,
    scenario_source: input.scenario ? "saved" : "fallback",
    steps: diffs,
    verdict: judge(diffs),
  };
}
