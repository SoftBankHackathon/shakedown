import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession } from "../src/http.ts";
import { runScenario, runStep } from "../src/steps.ts";
import { defaultScenario } from "../src/scenario.ts";
import { fillStep, makeValues } from "../src/placeholders.ts";
import { startFakeBoard } from "./fake-board.ts";

const boards: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(boards.map((b) => b.close())));

async function board(instances = 1) {
  const b = await startFakeBoard({ instances });
  boards.push(b);
  return b;
}

const steps = (runId: string) => defaultScenario.steps.map((s) => fillStep(s, makeValues(runId)));

test("서버 1대면 기본 시나리오 8단계가 모두 통과한다", async () => {
  const { url } = await board();
  const results = await runScenario(createSession(url), steps("aaa111"));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill("passed"));
  assert.equal(results[3].final_path, "/board");
  assert.deepEqual(results[7].hops.map((h) => [h.method, h.status]), [["POST", 302], ["GET", 200]]);
});

test("서버 2대에 세션이 따로면 로그인 뒤 / 로 튕기고 5단계에서 실패, 이후는 skipped", async () => {
  const { url } = await board(2);
  const results = await runScenario(createSession(url), steps("bbb222"));
  assert.equal(results[3].status, "passed");
  assert.equal(results[3].final_path, "/");
  assert.equal(results[4].status, "failed");
  assert.equal(results[4].error, "ended on /, expected /write");
  assert.deepEqual(results.slice(5).map((r) => [r.status, r.error]), Array(3).fill(["skipped", "an earlier step failed"]));
});

test("현재 페이지에 폼이 없으면 그 단계는 실패한다", async () => {
  const { url } = await board();
  const session = createSession(url);
  await session.request("GET", "/");
  const result = await runStep(session, steps("ccc333")[5], 6);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "request failed: form /api/posts/write not found on the current page");
});

test("서버가 꺼져 있으면 final_status가 null인 실패가 된다", async () => {
  const b = await startFakeBoard();
  await b.close();
  const [first] = await runScenario(createSession(b.url, { timeoutMs: 2000 }), steps("ddd444"));
  assert.equal(first.status, "failed");
  assert.equal(first.final_status, null);
  assert.match(first.error ?? "", /^request failed: /);
});

test("GET 폼은 값을 본문이 아니라 주소 뒤 쿼리로 보낸다", async () => {
  // 가짜 게시판에는 GET 폼이 없어서 작은 서버를 따로 띄운다.
  const server = createServer((req, res) => {
    if (req.url === "/") res.end(`<form action="/search" method="get"><input name="q"><input type="hidden" name="page" value="1"></form>`);
    else res.end(`searched ${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  boards.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  const session = createSession(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await session.request("GET", "/");
  const step = { title: "Search", action: "submit_form" as const, form_action: "/search", fields: [{ name: "q", value: "hello" }], expect: { text_contains: ["searched"] } };
  const result = await runStep(session, step, 1);
  assert.equal(result.status, "passed");
  assert.equal(result.final_path, "/search?q=hello&page=1"); // 브라우저처럼 폼에 적힌 순서
});

test("link_text나 path가 비어 있으면 아무 링크나 누르지 않고 실패한다", async () => {
  const { url } = await board();
  const session = createSession(url);
  await session.request("GET", "/join");
  const click = await runStep(session, { title: "Click", action: "click_link", link_text: null, fields: [], expect: { text_contains: [] } }, 1);
  assert.equal(click.error, "request failed: click_link step has no link_text");
  const visit = await runStep(session, { title: "Visit", action: "visit", path: null, fields: [], expect: { text_contains: [] } }, 2);
  assert.equal(visit.error, "request failed: visit step has no path");
});
