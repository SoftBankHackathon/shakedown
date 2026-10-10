import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startFakeBoard } from "./fake-board.ts";
import { startFakeApp } from "./fake-app.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const boards: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(boards.map((b) => b.close())));

async function board(instances = 1) {
  const b = await startFakeBoard({ instances });
  boards.push(b);
  return b.url;
}

test("주소 2개를 넣으면 결과 JSON을 출력한다 (PASS)", async () => {
  const { stdout } = await run(process.execPath, [cli, "--baseline", await board(), "--candidate", await board()]);
  const result = JSON.parse(stdout);
  assert.equal(result.verdict.status, "PASS");
  assert.equal(result.steps[0].candidate, "aws");
});

test("비교 환경이 서버 2대면 BLOCKED JSON을 출력한다", async () => {
  const { stdout } = await run(process.execPath, [cli, "--baseline", await board(), "--candidate", await board(2), "--candidate-name", "cloud"]);
  const result = JSON.parse(stdout);
  assert.equal(result.verdict.status, "BLOCKED");
  assert.equal(result.verdict.first_divergence, 4);
});

test("게시판이 아닌 앱은 시운전 API처럼 둘러본 페이지로 시나리오를 골라 돌린다(AI 없이)", async () => {
  const [baseline, candidate] = [await startFakeApp(), await startFakeApp()];
  boards.push(baseline, candidate);
  const { stdout } = await run(process.execPath, [cli, "--baseline", baseline.url, "--candidate", candidate.url]);
  const result = JSON.parse(stdout);
  assert.equal(result.verdict.status, "PASS");
  assert.equal(result.scenario_source, "fallback");
  assert.equal(result.scenario.app_understanding, "Rule-based crawl of 1 page (AI unavailable)");
});

test("기준 환경에서 열리는 페이지가 없으면 이유를 보여 주고 코드 1로 끝난다", async () => {
  const [baseline, candidate] = [await startFakeApp({ status: 503 }), await startFakeApp()];
  boards.push(baseline, candidate);
  await assert.rejects(run(process.execPath, [cli, "--baseline", baseline.url, "--candidate", candidate.url]), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.equal(err.stderr, "baseline local has no page to compare: / HTTP 503\n");
    return true;
  });
});

test("주소를 빠뜨리면 사용법을 보여 주고 코드 2로 끝난다", async () => {
  await assert.rejects(run(process.execPath, [cli, "--baseline", "http://x"]), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr, /^usage: /);
    return true;
  });
});

test("--timeout-ms가 숫자가 아니거나 주소가 틀리면 사용법을 보여 주고 코드 2로 끝난다", async () => {
  for (const args of [["--timeout-ms", "10s"], ["--timeout-ms", "0"]]) {
    await assert.rejects(run(process.execPath, [cli, "--baseline", "http://a", "--candidate", "http://b", ...args]), { code: 2 });
  }
  await assert.rejects(run(process.execPath, [cli, "--baseline", "not a url", "--candidate", "http://b"]), { code: 2 });
});
