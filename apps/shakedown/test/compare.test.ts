import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { StepResult } from "@shakedown/contracts";
import { compareSteps, normalizePath } from "../src/compare.ts";

const names = { baseline: "local", candidate: "cloud" };
const pick = (d: { kind: string; severity: string; reasons: string[]; classified_by: string }) =>
  ({ kind: d.kind, severity: d.severity, reasons: d.reasons, classified_by: d.classified_by });

for (const [n, attempt] of fixture.attempts.entries()) {
  test(`fixture 시도 ${n + 1}의 단계 비교 결과를 그대로 만든다`, () => {
    const local = attempt.steps.map((s) => s.local) as unknown as StepResult[];
    const cloud = attempt.steps.map((s) => s.cloud) as unknown as StepResult[];
    const diffs = compareSteps(local, cloud, names);
    assert.deepEqual(diffs.map(pick), attempt.steps.map(pick));
  });
}

test("숫자 경로 조각은 같은 것으로 본다", () => {
  assert.equal(normalizePath("/posts/11/view"), normalizePath("/posts/6/view"));
  assert.notEqual(normalizePath("/board"), normalizePath("/"));
});

test("둘 다 실패하면 both_failed, 둘 다 건너뛰면 skipped", () => {
  const r = (status: StepResult["status"]): StepResult => ({
    index: 1, title: "t", status, error: null, final_path: null, final_status: null, hops: [], checks: [], elapsed_ms: 0,
  });
  const [failed] = compareSteps([r("failed")], [r("failed")], names);
  assert.deepEqual(pick(failed), { kind: "both_failed", severity: "critical", reasons: ["failed on local, failed on cloud"], classified_by: "rule" });
  const [skipped] = compareSteps([r("skipped")], [r("skipped")], names);
  assert.deepEqual([skipped.kind, skipped.severity], ["skipped", "ignore"]);
});
