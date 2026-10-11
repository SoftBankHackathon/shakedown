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
    summary: "Step 4 (Sign in) led to different pages (/board on Local, / on cloud).",
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

test("판정 요약은 표시 이름과 요청 언어로 쓰고, 판정(status·first_divergence)은 언어와 상관없다", () => {
  const gcp = (steps: unknown[]) => (steps as StepDiff[]).map((d) => ({ ...d, baseline: "local", candidate: "gcp" }));
  const blocked = gcp(fixture.attempts[0].steps);
  assert.equal(judge(blocked).summary, "Step 4 (Sign in) led to different pages (/board on Local, / on GCP).");
  assert.deepEqual(judge(blocked, "ko"), { status: "BLOCKED", first_divergence: 4, summary: "4단계(Sign in)에서 도착한 화면이 다릅니다(Local: /board, GCP: /)." });
  assert.equal(judge(blocked, "ja").summary, "ステップ 4（Sign in）で到達した画面が異なります（Local: /board、GCP: /）。");
  const passed = gcp(fixture.attempts[1].steps);
  assert.deepEqual(judge(passed, "ko"), { status: "PASS", first_divergence: null, summary: "모든 단계에서 두 환경이 똑같이 동작했습니다." });
  assert.equal(judge(passed, "ja").summary, "すべてのステップで両環境の動作が一致しました。");
});

test("두 환경 모두 실패한 단계의 한국어 요약은 제목 끝 받침과 상관없이 맞는 문장", () => {
  const steps = withNames(fixture.attempts[1].steps);
  steps[3] = { ...steps[3], title: "로그인", kind: "both_failed", severity: "critical" };
  assert.equal(judge(steps, "ko").summary, "4단계(로그인): 두 환경 모두에서 실패했습니다.");
});
