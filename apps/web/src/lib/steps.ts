import type { StepDiff, StepResult } from "./api";

// The engine runs one shakedown per cloud against the same baseline, so an attempt's rows
// can hold several comparisons. Each row names its candidate; older rows may not.

/** Rows grouped by compared candidate, in run order. */
export function byCandidate(rows: StepDiff[], names: string[], baseline: string): [string, StepDiff[]][] {
  const fallback = names.find((n) => n !== baseline) ?? "";
  const groups = new Map<string, StepDiff[]>();
  for (const row of rows) {
    const name = row.candidate ?? fallback;
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups];
}

/** One target's results: the baseline side of the first comparison, or the candidate side of its own. */
export function resultsFor(rows: StepDiff[], names: string[], baseline: string, name: string): StepResult[] {
  const groups = byCandidate(rows, names, baseline);
  if (name === baseline) return (groups[0]?.[1] ?? []).map((row) => row.local);
  return (groups.find(([candidate]) => candidate === name)?.[1] ?? []).map((row) => row.cloud);
}
