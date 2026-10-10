import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chooseScenario } from "../src/choose.ts";
import { defaultScenario } from "../src/scenario.ts";
import { startFakeBoard } from "./fake-board.ts";
import { startFakeApp, type FakeAppOptions } from "./fake-app.ts";
import { answered, startFakeClaude } from "./fake-claude.ts";

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function app(options: FakeAppOptions = {}) {
  const a = await startFakeApp(options);
  servers.push(a);
  return a;
}

test("kty-board면 알려진 시나리오를 고른다", async () => {
  const board = await startFakeBoard();
  servers.push(board);
  const choice = await chooseScenario({ name: "local", url: board.url }, { ai: {} });
  assert.deepEqual([choice.scenario, choice.source], [defaultScenario, "fallback"]);
});

test("/join 폼이 있어도 다음 단계가 보낼 칸(email·nickname·password)이 없으면 알려진 시나리오가 아니다", async () => {
  const a = await app({ pages: { "/join": `<form action="/join" method="post"><input name="username"><input name="phone"></form>` } });
  const choice = await chooseScenario({ name: "local", url: a.url }, { ai: {} });
  assert.equal(choice.scenario.app_understanding, "Rule-based crawl of 1 page (AI unavailable)");
  assert.ok(a.hits.every((h) => h.startsWith("GET ")), a.hits.join(", "));
});

test("AI 시나리오 미리 돌려 보기는 본 실행 몫(남은 시간의 3분의 2)을 넘기면 끊고 규칙 둘러보기로 간다", async (t) => {
  // 시계만 가짜로 둔다. 가짜 Claude가 답하기 전에 30초를 흘려, 미리 돌려 볼 시간이 남지 않은 상황을 만든다.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const scenario = {
    app_understanding: "A JSON status endpoint.",
    steps: [{ title: "Open the status", action: "visit", path: "/", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: [] } }],
  };
  const claude = await startFakeClaude(t, (res, seen) => {
    t.mock.timers.tick(30_000);
    answered(scenario)(res, seen);
  });
  const a = await app();
  // AI를 부를 수 있는 가장 짧은 본 실행 마감(남은 시간 - 23초 ≥ 5초)보다 조금 길게 둔다.
  const deadlineAt = Date.now() + 28_500;
  const spent: unknown[] = [];
  const choice = await chooseScenario(
    { name: "local", url: a.url },
    { ai: { apiKey: "sk-ant-test-dummy", baseURL: claude.baseURL }, deadlineAt, onSpent: (cost) => spent.push(cost) },
  );
  assert.equal(claude.seen.length, 1);
  assert.equal(choice.source, "fallback");
  assert.equal(choice.cost.calls, 1);
  // AI 비용은 받자마자 알린다. 그 뒤 마감에 걸려 고르기가 예외로 끝나도 기록에 남게 하기 위해서다.
  assert.deepEqual(spent, [choice.cost]);
  // 미리 돌려 보기 요청은 보내기 전에 끊겼다: 기준 환경이 받은 것은 알려진 시나리오 확인과 둘러보기뿐이다.
  assert.deepEqual(a.hits, ["GET /join", "GET /"]);
});

test("미리 돌려 보기 도중에 실행·보고서 몫에 닿으면 그 자리에서 끊는다", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // 기준 환경: "/"는 바로, "/slow"는 3초 뒤에 답한다. AI 시나리오는 /slow를 연다.
  const server = createServer((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.end("slow"), 3_000);
    res.writeHead(200, { "content-type": "application/json" }).end(`{"language":"node"}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
  const scenario = {
    app_understanding: "A JSON status endpoint.",
    steps: [{ title: "Open the slow page", action: "visit", path: "/slow", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: [] } }],
  };
  // 답하기 전에 24초를 흘려 남은 시간을 4.5초로 만든다. 그 3분의 1인 1.5초만 미리 돌려 볼 수 있다.
  const claude = await startFakeClaude(t, (res, seen) => {
    t.mock.timers.tick(24_000);
    answered(scenario)(res, seen);
  });
  const deadlineAt = Date.now() + 28_500;
  const started = performance.now();
  const choice = await chooseScenario(
    { name: "local", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    { ai: { apiKey: "sk-ant-test-dummy", baseURL: claude.baseURL }, deadlineAt },
  );
  assert.equal(choice.source, "fallback");
  assert.ok(performance.now() - started < 2_900, `took ${Math.round(performance.now() - started)}ms`);
});
