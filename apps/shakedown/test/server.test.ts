import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createShakedownServer, type Shakedown } from "../src/server.ts";
import { defaultScenario } from "../src/scenario.ts";
import { startFakeBoard } from "./fake-board.ts";

const servers: Server[] = [];
const boards: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const s of servers) s.closeAllConnections();
  await Promise.all([...servers.map((s) => new Promise((resolve) => s.close(resolve))), ...boards.map((b) => b.close())]);
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// 접속 확인 대기는 테스트에서 짧게 둔다(기본 20초). AI는 기본으로 끈다 → 테스트가 진짜 API 키를 쓰지 않는다.
const api = (options: Parameters<typeof createShakedownServer>[0] = {}) =>
  listen(createShakedownServer({ reachWaitMs: 300, ai: {}, ...options }));

async function board(options: { instances?: number; delayMs?: number } = {}) {
  const b = await startFakeBoard(options);
  boards.push(b);
  return b.url;
}

const request = (baseline: string, candidate: string, extra: Record<string, unknown> = {}) => ({
  deployment_id: "dep_test",
  baseline: { name: "local", url: baseline },
  candidates: [{ name: "aws", url: candidate }],
  ...extra,
});

type ErrorBody = { error?: string; detail?: string };

async function post(base: string, body: unknown): Promise<{ status: number; body: Shakedown & ErrorBody }> {
  const res = await fetch(`${base}/shakedowns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** running이 끝날 때까지 GET을 반복한다. 도중에 받은 응답은 snapshots에 모은다. */
async function waitDone(base: string, id: string, snapshots: Shakedown[] = []): Promise<Shakedown> {
  for (let i = 0; i < 500; i++) {
    const sd = (await (await fetch(`${base}/shakedowns/${id}`)).json()) as Shakedown;
    snapshots.push(sd);
    if (sd.status !== "running") return sd;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`shakedown ${id} is still running`);
}

test("POST는 202와 running 상태를 바로 돌려주고, 끝나면 PASS", async () => {
  const base = await api();
  const { status, body } = await post(base, request(await board(), await board()));
  assert.equal(status, 202);
  assert.match(body.shakedown_id, /^sd_[0-9a-f]{10}$/);
  assert.deepEqual(body, {
    shakedown_id: body.shakedown_id,
    status: "running",
    scenario: defaultScenario,
    scenario_source: "fallback",
    steps: [],
    ai_cost: { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 },
  });

  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done");
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.report, null);
  assert.equal(done.steps.length, 8);
  assert.equal(done.steps[0].candidate, "aws");
});

test("비교 환경이 서버 2대면 BLOCKED, 4단계에서 갈라진다", async () => {
  const base = await api();
  const { body } = await post(base, request(await board(), await board({ instances: 2 })));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.verdict, {
    status: "BLOCKED",
    first_divergence: 4,
    summary: "Step 4 (Sign in) led to different pages (/board on local, / on aws).",
  });
  assert.equal(done.report?.headline, "Login is lost on aws: requests land on different instances");
  assert.equal(done.report?.by, "rule");
  assert.equal(done.report?.fix?.option, "sticky_sessions");
});

test("비교 환경이 꺼져 있으면 BLOCKED와 접속 불가 보고서", async () => {
  const down = await startFakeBoard();
  await down.close();
  const base = await api();
  const { body } = await post(base, request(await board(), down.url));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done");
  assert.equal(done.verdict?.first_divergence, 1);
  assert.equal(done.report?.headline, "aws is not reachable");
});

test("기준 환경이 꺼져 있으면 비교할 수 없으니 failed", async () => {
  const down = await startFakeBoard();
  await down.close();
  const base = await api();
  const { body } = await post(base, request(down.url, await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, `baseline local is not reachable: ${down.url}`);
});

test("기준 환경이 시나리오를 통과하지 못하면 failed, 단계 결과는 남긴다", async () => {
  const base = await api();
  const { body } = await post(base, request(await board({ instances: 2 }), await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "baseline local failed at step 5 (Open the editor): ended on /, expected /write");
  assert.equal(done.steps.length, 8);
  assert.equal(done.verdict, undefined);
});

test("진행 중에는 두 환경이 모두 끝낸 단계까지만 steps에 담긴다", async () => {
  const base = await api();
  const { body } = await post(base, request(await board(), await board({ delayMs: 30 })));
  const snapshots: Shakedown[] = [];
  const done = await waitDone(base, body.shakedown_id, snapshots);
  const running = snapshots.filter((s) => s.status === "running");

  assert.ok(running.some((s) => s.steps.length > 0 && s.steps.length < 8), "중간 단계가 보여야 한다");
  for (const s of running) {
    assert.equal(s.verdict, undefined);
    assert.deepEqual(s.steps, done.steps.slice(0, s.steps.length));
  }
  const lengths = running.map((s) => s.steps.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
});

test("시나리오를 넘기면 그 시나리오로 돌리고 saved로 표시한다", async () => {
  const scenario = {
    app_understanding: "just the sign-up page",
    steps: [{ title: "Open sign-up page", action: "visit", path: "/join", fields: [], expect: { path_startswith: "/join", text_contains: [] } }],
  };
  const base = await api();
  const { status, body } = await post(base, request(await board(), await board(), { scenario }));
  assert.equal(status, 202);
  assert.equal(body.scenario_source, "saved");
  assert.deepEqual(body.scenario, scenario);

  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.steps.length, 1);
  assert.equal(done.verdict?.status, "PASS");
});

test("scenario가 null이면 기본 시나리오(fallback)로 돌린다", async () => {
  const base = await api();
  const { body } = await post(base, request(await board(), await board(), { scenario: null }));
  assert.equal(body.scenario_source, "fallback");
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.steps.length, 8);
});

test("실행 중 오류가 나면 failed와 오류 메시지를 돌려준다", async () => {
  const scenario = {
    app_understanding: "unknown placeholder",
    steps: [{ title: "Open", action: "visit", path: "/{{nope}}", fields: [], expect: { text_contains: [] } }],
  };
  const base = await api();
  const { body } = await post(base, request(await board(), await board(), { scenario }));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "unknown placeholder {{nope}}");
});

test("마감 시간을 넘기면 failed로 끝내고, 그 뒤에 끝난 단계로 덮어쓰지 않는다", async () => {
  let requests = 0;
  const silent = createServer(() => { requests++; });
  const base = await api({ deadlineMs: 200 });
  const { body } = await post(base, request(await board(), await listen(silent)));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "timed out after 0.2s");
  assert.deepEqual(done.steps, []);
  assert.equal(done.verdict, undefined);

  // Deadline cancellation must prevent preflight retries and all subsequent writes.
  const atDeadline = requests;
  silent.closeAllConnections();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, atDeadline);
  assert.deepEqual(await (await fetch(`${base}/shakedowns/${body.shakedown_id}`)).json(), done);
});

test("없는 id는 404", async () => {
  const res = await fetch(`${await api()}/shakedowns/sd_0000000000`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "shakedown sd_0000000000 not found" });
});

test("JSON이 아니면 400", async () => {
  const { status, body } = await post(await api(), "{not json");
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "invalid request", detail: "body must be valid JSON" });
});

test("필수 값이 빠지거나 형식이 틀리면 400", async () => {
  const base = await api();
  const ok = request("http://127.0.0.1:1", "http://127.0.0.1:2");
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...ok, deployment_id: undefined }, /deployment_id/],
    [{ ...ok, baseline: undefined }, /baseline/],
    [{ ...ok, baseline: { name: "local", url: "not a url" } }, /baseline/],
    [{ ...ok, candidates: [] }, /candidates/],
    [{ ...ok, candidates: [{ name: "aws" }] }, /candidate/],
    [{ ...ok, scenario: { app_understanding: "empty", steps: [] } }, /scenario/],
  ];
  for (const [body, error] of cases) {
    const res = await post(base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, "invalid request");
    assert.match(res.body.detail ?? "", error);
  }
});

test("비교 대상이 2개 이상이면 422", async () => {
  const body = request("http://127.0.0.1:1", "http://127.0.0.1:2");
  body.candidates.push({ name: "gcp", url: "http://127.0.0.1:3" });
  const { status, body: res } = await post(await api(), body);
  assert.equal(status, 422);
  assert.deepEqual(res, { error: "unsupported request", detail: "only one candidate is supported for now (got 2)" });
});

test("main.ts는 HOST:PORT에서 듣고 한 줄 로그를 남긴다", async () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const child = spawn(process.execPath, [main], { env: { ...process.env, PORT: "0", SHAKEDOWN_AI_REPORT: "off" } });
  try {
    const [chunk] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    const port = /^shakedown api listening on 127\.0\.0\.1:(\d+)\n$/.exec(String(chunk))?.[1];
    assert.ok(port, String(chunk));
    const res = await fetch(`http://127.0.0.1:${port}/shakedowns/sd_x`);
    assert.equal(res.status, 404);
  } finally {
    child.kill();
  }
});


test("본문이 1MB를 넘으면 413으로 거절한다", async () => {
  const res = await fetch(`${await api()}/shakedowns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1_100_000) }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "invalid request", detail: "body is larger than 1MB" });
});

test("AI가 켜져 있으면 BLOCKED 보고서를 AI가 쓰고 비용을 기록한다", async () => {
  // 가짜 Claude API: 받은 요청의 사용자 내용에 규칙 보고서와 hints가 들어 있는지 보고, 정해진 보고서를 돌려준다.
  let prompt: { rule_report: { headline: string } | null; hints: Record<string, unknown> } | undefined;
  const claude = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    prompt = JSON.parse(JSON.parse(raw).messages[0].content);
    const report = { headline: "AI headline", cause: "AI cause", evidence: ["e1"], fix: null, confidence: "medium" };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", container: null, context_management: null,
      content: [{ type: "text", text: JSON.stringify(report), citations: null }],
      stop_reason: "end_turn", stop_sequence: null, stop_details: null,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));
  });
  const base = await api({ ai: { apiKey: "test-key", baseURL: await listen(claude) } });
  const { body } = await post(base, request(await board(), await board({ instances: 2 }), { hints: { uses_server_session: true } }));
  const done = await waitDone(base, body.shakedown_id);

  assert.equal(done.status, "done");
  assert.deepEqual(done.report, { headline: "AI headline", cause: "AI cause", evidence: ["e1"], fix: null, confidence: "medium", by: "ai" });
  assert.deepEqual(done.ai_cost, { calls: 1, input_tokens: 1000, output_tokens: 500, krw: 19.6 });
  assert.equal(prompt?.rule_report?.headline, "Login is lost on aws: requests land on different instances");
  assert.deepEqual(prompt?.hints, { uses_server_session: true });
});

test("AI가 켜져 있어도 PASS면 부르지 않고 report는 null", async () => {
  let called = false;
  const claude = createServer((_, res) => {
    called = true;
    res.writeHead(500).end();
  });
  const base = await api({ ai: { apiKey: "test-key", baseURL: await listen(claude) } });
  const { body } = await post(base, request(await board(), await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.report, null);
  assert.equal(called, false);
});

test("마감이 가까우면 AI를 기다리다 판정을 잃지 않고 규칙 보고서로 끝낸다", async () => {
  const silent = createServer(() => {
    /* 가짜 Claude가 응답하지 않음 */
  });
  const base = await api({ deadlineMs: 3_000, ai: { apiKey: "test-key", baseURL: await listen(silent) } });
  const { body } = await post(base, request(await board(), await board({ instances: 2 })));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done");
  assert.equal(done.verdict?.status, "BLOCKED");
  assert.equal(done.report?.by, "rule");
});
