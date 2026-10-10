import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { StepDiff } from "@shakedown/contracts";
import { runShakedown } from "../src/shakedown.ts";
import { defaultScenario } from "../src/scenario.ts";
import { startFakeBoard } from "./fake-board.ts";

const boards: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(boards.map((b) => b.close())));

async function board(instances = 1) {
  const b = await startFakeBoard({ instances });
  boards.push(b);
  return b.url;
}

test("두 환경 모두 서버 1대면 PASS", async () => {
  const result = await runShakedown({
    baseline: { name: "local", url: await board() },
    candidate: { name: "aws", url: await board() },
    runId: "eee555",
  });
  assert.equal(result.verdict.status, "PASS");
  // 시나리오를 넘기지 않으면 kty-board 기본 시나리오로 돈다.
  assert.equal(result.scenario, defaultScenario);
  assert.equal(result.steps.length, 8);
  assert.equal(result.steps[6].kind, "same"); // /posts/1 과 /posts/1 (번호가 달라도 same)
});

test("비교 환경만 서버 2대면 4단계에서 갈라져 BLOCKED", async () => {
  const result = await runShakedown({
    baseline: { name: "local", url: await board() },
    candidate: { name: "aws", url: await board(2) },
    runId: "fff666",
  });
  assert.deepEqual(result.verdict, {
    status: "BLOCKED",
    first_divergence: 4,
    summary: "Step 4 (Sign in) led to different pages (/board on local, / on aws).",
  });
  assert.deepEqual(result.steps.map((s) => s.kind), ["same", "same", "same", "path_diff", "env_diff", "env_diff", "env_diff", "env_diff"]);
});

test("비교 환경이 꺼져 있으면 1단계부터 BLOCKED", async () => {
  const down = await startFakeBoard();
  await down.close();
  const result = await runShakedown({
    baseline: { name: "local", url: await board() },
    candidate: { name: "aws", url: down.url },
    timeoutMs: 2000,
  });
  assert.equal(result.verdict.status, "BLOCKED");
  assert.equal(result.verdict.first_divergence, 1);
});

test("시나리오를 넘기면 그 시나리오로 실행한다", async () => {
  const scenario = {
    app_understanding: "just the sign-up page",
    steps: [{ title: "Open sign-up page", action: "visit" as const, path: "/join", form_action: null, link_text: null, fields: [], expect: { path_startswith: "/join", text_contains: [] } }],
  };
  const result = await runShakedown({
    baseline: { name: "local", url: await board() },
    candidate: { name: "aws", url: await board() },
    scenario,
  });
  assert.equal(result.scenario, scenario);
  assert.equal(result.steps.length, 1);
  assert.equal(result.verdict.status, "PASS");
});

test("onProgress는 두 환경이 모두 끝낸 단계가 늘 때마다 그때까지의 비교를 넘긴다", async () => {
  // 비교 환경만 느리게 해서, 기준 환경이 먼저 끝나도 두 쪽이 다 끝낸 단계까지만 알리는지 본다.
  const slow = await startFakeBoard({ delayMs: 5 });
  boards.push(slow);
  const calls: StepDiff[][] = [];
  const result = await runShakedown({
    baseline: { name: "local", url: await board() },
    candidate: { name: "aws", url: slow.url },
    runId: "hhh888",
    onProgress: (steps) => calls.push(steps),
  });
  assert.deepEqual(calls.map((c) => c.length), [1, 2, 3, 4, 5, 6, 7, 8]);
  calls.forEach((c) => assert.deepEqual(c, result.steps.slice(0, c.length)));
});
