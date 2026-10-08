import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { StepDiff } from "@shakedown/contracts";
import { judge } from "../src/verdict.ts";

const withNames = (steps: unknown[]) => (steps as StepDiff[]).map((d) => ({ ...d, baseline: "local", candidate: "cloud" }));

test("로그인 뒤 경로가 갈라진 시도는 BLOCKED, 처음 달라진 단계는 4", () => {
  assert.deepEqual(judge(withNames(fixture.attempts[0].steps)), {
    status: "BLOCKED",
    first_divergence: 4,
    summary: "Step 4 (Sign in) led to different pages (/board on local, / on cloud).",
  });
});

test("모든 단계가 같은 시도는 fixture와 똑같은 PASS 판정", () => {
  assert.deepEqual(judge(withNames(fixture.attempts[1].steps)), fixture.attempts[1].verdict);
});

test("critical 없이 warn만 있으면 WARN", () => {
  const steps = withNames(fixture.attempts[1].steps);
  steps[2] = { ...steps[2], kind: "text_diff", severity: "warn", reasons: ["page text differs"] };
  assert.deepEqual(judge(steps), {
    status: "WARN",
    first_divergence: 3,
    summary: "Step 3 (Open sign-in page): page text differs.",
  });
});
