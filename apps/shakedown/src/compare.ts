// 기준 환경(baseline)과 비교 환경(candidate)의 단계 결과를 맞대서 StepDiff를 만든다.
// 규칙과 문구는 contracts fixture(deployment-blocked-then-fixed.json)에 맞춘다.
import type { StepDiff, StepResult } from "@shakedown/contracts";

export type Names = { baseline: string; candidate: string };

/** 글 번호처럼 환경마다 다른 숫자 경로 조각은 같은 것으로 본다. /posts/11 ≡ /posts/6 */
export function normalizePath(path: string | null): string | null {
  return path === null ? null : path.replace(/\/\d+(?=\/|\?|$)/g, "/{n}");
}

function classify(b: StepResult, c: StepResult, n: Names): Pick<StepDiff, "kind" | "severity" | "reasons"> {
  const ended = `ended on ${b.final_path ?? "None"} (${n.baseline}) vs ${c.final_path ?? "None"} (${n.candidate})`;

  if (b.status === "passed" && c.status === "passed") {
    return normalizePath(b.final_path) === normalizePath(c.final_path)
      ? { kind: "same", severity: "none", reasons: [] }
      : { kind: "path_diff", severity: "critical", reasons: [ended] };
  }
  if (b.status === "skipped" && c.status === "skipped") {
    return { kind: "skipped", severity: "ignore", reasons: [] };
  }
  if (b.status !== "passed" && c.status !== "passed") {
    return { kind: "both_failed", severity: "critical", reasons: [`${b.status} on ${n.baseline}, ${c.status} on ${n.candidate}`] };
  }
  const [bad, okName, badName] = b.status === "passed" ? [c, n.baseline, n.candidate] : [b, n.candidate, n.baseline];
  return {
    kind: "env_diff",
    severity: "critical",
    reasons: [`passed on ${okName}, ${bad.status} on ${badName}`, ...(bad.error ? [bad.error] : []), ended],
  };
}

export function compareSteps(baseline: StepResult[], candidate: StepResult[], names: Names): StepDiff[] {
  return baseline.map((b, i) => {
    const c = candidate[i];
    return {
      index: b.index,
      baseline: names.baseline,
      candidate: names.candidate,
      title: b.title,
      local: b,
      cloud: c,
      ...classify(b, c, names),
      classified_by: "rule",
    };
  });
}
