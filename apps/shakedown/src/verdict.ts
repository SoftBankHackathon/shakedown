// 단계 비교 결과로 최종 판정을 내린다. AI는 관여하지 않는다.
import type { Attempt, StepDiff } from "@shakedown/contracts";

export type Verdict = NonNullable<Attempt["verdict"]>;

function describe(d: StepDiff): string {
  const head = `Step ${d.index} (${d.title})`;
  if (d.kind === "path_diff") {
    return `${head} led to different pages (${d.local.final_path} on ${d.baseline}, ${d.cloud.final_path} on ${d.candidate}).`;
  }
  if (d.kind === "both_failed") return `${head} failed on both environments.`;
  return `${head}: ${d.reasons.join("; ")}.`;
}

export function judge(diffs: StepDiff[]): Verdict {
  const critical = diffs.find((d) => d.severity === "critical");
  const warn = diffs.find((d) => d.severity === "warn");
  const first = diffs.find((d) => d.severity === "critical" || d.severity === "warn");

  if (critical) return { status: "BLOCKED", first_divergence: first!.index, summary: describe(critical) };
  if (warn) return { status: "WARN", first_divergence: first!.index, summary: describe(warn) };
  return { status: "PASS", first_divergence: null, summary: "Both environments behaved the same on every step." };
}
