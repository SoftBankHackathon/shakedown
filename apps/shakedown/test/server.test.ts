import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createShakedownServer, type Shakedown } from "../src/server.ts";
import { defaultScenario } from "../src/scenario.ts";
import { startFakeBoard } from "./fake-board.ts";
import { startFakeApp, type FakeAppOptions } from "./fake-app.ts";
import { answered, json, message, type Reply, type Seen } from "./fake-claude.ts";

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

// 접속 확인 대기는 테스트에서 짧게 둔다(기본 20초). AI(보고서·시나리오)는 기본으로 끈다 → 테스트가 진짜 API 키를 쓰지 않는다.
const api = (options: Parameters<typeof createShakedownServer>[0] = {}) =>
  listen(createShakedownServer({ reachWaitMs: 300, ai: {}, aiScenario: {}, ...options }));

async function board(options: { instances?: number; delayMs?: number } = {}) {
  const b = await startFakeBoard(options);
  boards.push(b);
  return b.url;
}

// 게시판이 아닌 앱(examples/http-node 모양). hits로 받은 요청을 본다.
async function app(options: FakeAppOptions = {}) {
  const a = await startFakeApp(options);
  boards.push(a);
  return a;
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
  // 시나리오가 요청에 없으면 기준 환경을 본 뒤에 고르므로 202 응답에는 아직 없다.
  assert.deepEqual(body, {
    shakedown_id: body.shakedown_id,
    status: "running",
    steps: [],
    ai_cost: { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 },
  });

  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done");
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.report, null);
  // kty-board는 알려진 시나리오(기본 8단계)의 앞부분이 맞아서 그 시나리오로 돈다.
  assert.deepEqual([done.scenario, done.scenario_source], [defaultScenario, "fallback"]);
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
  assert.equal(done.report?.fix?.option, "env");
  // 엔진이 env를 바꿀 수 있다고 알려 주지 않았으니(hints 없음) 제안만 한다.
  assert.equal(done.report?.fix?.auto_applicable, false);
});

test("hints.can_apply_env=true면 로그인 풀림 수정안이 자동 적용 가능", async () => {
  const base = await api();
  const { body } = await post(base, request(await board(), await board({ instances: 2 }), { hints: { can_apply_env: true } }));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.verdict?.status, "BLOCKED");
  assert.equal(done.report?.fix?.option, "env");
  assert.equal(done.report?.fix?.value, "SPRING_PROFILES_ACTIVE=demo,session-jdbc");
  assert.equal(done.report?.fix?.auto_applicable, true);
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

test("기준 환경이 계속 Cloudflare 530(터널 미준비)이면 1단계 실패가 아니라 접속 불가로 failed", async () => {
  const tunnel = await listen(createServer((_, res) => res.writeHead(530, { server: "cloudflare" }).end("error code: 1033")));
  const base = await api();
  const { body } = await post(base, request(tunnel, await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, `baseline local is not reachable: ${tunnel}`);
  assert.deepEqual(done.steps, []);
});

test("기준 환경이 접속 확인 뒤 잠깐 Cloudflare 530을 내도(200 → 530 → 200) 시운전을 끝낸다", async () => {
  // Cloudflare 엣지 흉내: 세 번째 요청(접속 확인, 알려진 시나리오 확인 GET /join 다음의 1단계 GET /join)만 앱에 넘기지 않고 530으로 답한다.
  const app = new URL(await board());
  let hits = 0;
  const edge = await listen(createServer((req, res) => {
    if (++hits === 3) return void res.writeHead(530, { server: "cloudflare", "content-type": "text/html" }).end("Error 1033");
    req.pipe(httpRequest({ host: app.hostname, port: app.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }));
  }));
  const base = await api();
  const { body } = await post(base, request(edge, await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.steps.length, 8);
  assert.deepEqual(done.steps[0].local.hops, [{ method: "GET", path: "/join", status: 200, instance: null }]);
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

test("scenario가 null이면 없는 것과 같게 기준 환경을 보고 고른다(kty-board면 기본 시나리오)", async () => {
  const base = await api();
  const { body } = await post(base, request(await board(), await board(), { scenario: null }));
  assert.equal(body.scenario_source, undefined);
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.scenario_source, "fallback");
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

test("게시판이 아닌 앱: 기준 환경을 GET으로만 둘러본 페이지로 규칙 시나리오를 만들어 PASS", async () => {
  const [baseline, candidate] = [await app(), await app()];
  const base = await api();
  const { body } = await post(base, request(baseline.url, candidate.url, { hints: { health_path: "/healthz" } }));
  const snapshots: Shakedown[] = [];
  const done = await waitDone(base, body.shakedown_id, snapshots);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.scenario_source, "fallback");
  assert.equal(done.scenario?.app_understanding, "Rule-based crawl of 2 pages (AI unavailable)");
  assert.deepEqual(done.steps.map((d) => d.title), ["Open /", "Open /healthz"]);
  // 엔진은 폴링할 때마다 scenario를 복사하고 steps 수와 비교한다. 단계가 보이기 시작하면 시나리오도 이미 있어야 한다.
  for (const s of snapshots.filter((s) => s.steps.length > 0)) assert.deepEqual(s.scenario, done.scenario);
  // 알려진 시나리오 확인(GET /join)과 둘러보기는 GET만 보낸다.
  assert.ok(baseline.hits.every((h) => h.startsWith("GET ")), baseline.hits.join(", "));
  assert.ok(candidate.hits.every((h) => h.startsWith("GET ")), candidate.hits.join(", "));
});

test("게시판이 아닌 앱: 비교 환경만 500이면 BLOCKED와 스택 중립 서버 오류 보고서", async () => {
  const base = await api();
  const { body } = await post(base, request((await app()).url, (await app({ status: 500 })).url));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.verdict?.status, "BLOCKED");
  assert.equal(done.verdict?.first_divergence, 1);
  assert.equal(done.report?.headline, "aws fails with a server error (HTTP 500)");
  assert.equal(done.report?.fix?.option, "code_change");
  assert.doesNotMatch(done.report?.fix?.native ?? "", /App Runner|application\.yml/);
});

test("게시판이 아닌 앱: 기준 환경에서 열리는 페이지가 하나도 없으면 failed와 이유", async () => {
  const base = await api();
  const { body } = await post(base, request((await app({ status: 503 })).url, (await app()).url, { hints: { health_path: "/healthz" } }));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "baseline local has no page to compare: / HTTP 503, /healthz HTTP 503");
  assert.equal(done.scenario, undefined);
  assert.deepEqual(done.steps, []);
});

const AI_KEY = "sk-ant-test-dummy";
const aiSteps = (texts: string[]) => ({
  app_understanding: "A JSON status endpoint that reports its language and DB.",
  steps: [
    { title: "Open the status", action: "visit", path: "/", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: texts } },
    { title: "Open the health check", action: "visit", path: "/healthz", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: [] } },
  ],
});
const aiReportBody = { headline: "AI headline", cause: "AI cause", evidence: ["e1"], fix: null, confidence: "medium" };

/** 가짜 Claude: 받은 구조화 출력 스키마를 보고 시나리오 요청인지 보고서 요청인지 가려 답한다. */
async function fakeClaude(scenarioReply: Reply) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method!, url: req.url!, headers: req.headers, body: JSON.parse(raw) };
    seen.push(entry);
    if (entry.body.output_config.format.schema.required[0] === "app_understanding") return scenarioReply(res, entry);
    answered(aiReportBody)(res, entry);
  });
  return { baseURL: await listen(server), seen, scenarioCalls: () => seen.filter((s) => s.body.output_config.format.schema.required[0] === "app_understanding") };
}

test("AI 시나리오: 기준 환경에서 미리 돌려 통과하면 채택하고 scenario_source ai, 비용을 기록한다", async () => {
  const claude = await fakeClaude(answered(aiSteps(["language"])));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const { body } = await post(base, request((await app()).url, (await app()).url, { hints: { health_path: "/healthz" } }));
  assert.equal(body.scenario, undefined);
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.verdict?.status, "PASS");
  assert.deepEqual([done.scenario, done.scenario_source], [aiSteps(["language"]), "ai"]);
  assert.deepEqual(done.ai_cost, { calls: 1, input_tokens: 1000, output_tokens: 500, krw: 19.6 });
  // AI에게는 둘러본 페이지와 hints를 준다.
  const prompt = JSON.parse(claude.seen[0].body.messages[0].content);
  assert.deepEqual(prompt.pages.map((p: { path: string }) => p.path), ["/", "/healthz"]);
  assert.deepEqual(prompt.hints, { health_path: "/healthz" });
});

test("AI 시나리오가 기준 환경에서 실패하면 버리고 규칙 둘러보기로 돌리되 AI 비용은 남긴다", async () => {
  const claude = await fakeClaude(answered(aiSteps(["text that is not there"])));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const { body } = await post(base, request((await app()).url, (await app()).url));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.scenario_source, "fallback");
  assert.equal(done.scenario?.app_understanding, "Rule-based crawl of 1 page (AI unavailable)");
  assert.equal(done.ai_cost.calls, 1);
});

test("AI 시나리오가 실패·거절이면 규칙 둘러보기로 돌린다", async () => {
  for (const reply of [json(500, { type: "error", error: { type: "api_error", message: "boom" } }), json(200, message("{}", "refusal"))]) {
    const claude = await fakeClaude(reply);
    const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
    const { body } = await post(base, request((await app()).url, (await app()).url));
    const done = await waitDone(base, body.shakedown_id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.scenario_source, "fallback");
    assert.equal(claude.scenarioCalls().length, 1);
  }
});

test("AI 시나리오 비용과 AI 보고서 비용을 합쳐 ai_cost에 넣는다", async () => {
  const claude = await fakeClaude(answered(aiSteps(["language"])));
  const ai = { apiKey: AI_KEY, baseURL: claude.baseURL };
  const base = await api({ ai, aiScenario: ai });
  // 미리 돌려 보기는 기준 환경에서만 하므로 비교 환경은 처음부터 깨진 채로 둔다(접속 확인은 500도 닿은 것으로 본다).
  const { body } = await post(base, request((await app()).url, (await app({ status: 500 })).url, { hints: { health_path: "/healthz" } }));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.verdict?.status, "BLOCKED", done.error);
  assert.equal(done.report?.by, "ai");
  assert.deepEqual(done.ai_cost, { calls: 2, input_tokens: 2000, output_tokens: 1000, krw: 39.2 });
});

test("알려진 시나리오가 맞으면(kty-board) AI 시나리오를 부르지 않는다", async () => {
  const claude = await fakeClaude(answered(aiSteps(["language"])));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const { body } = await post(base, request(await board(), await board()));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.verdict?.status, "PASS");
  assert.equal(done.scenario_source, "fallback");
  assert.equal(claude.seen.length, 0);
});

test("마감까지 남은 시간이 모자라면 AI 시나리오를 부르지 않고 규칙 둘러보기로 돌린다", async () => {
  const claude = await fakeClaude(answered(aiSteps(["language"])));
  const base = await api({ deadlineMs: 30_000, aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const { body } = await post(base, request((await app()).url, (await app()).url));
  const done = await waitDone(base, body.shakedown_id);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.scenario_source, "fallback");
  assert.equal(claude.seen.length, 0);
});

test("같은 배포(deployment_id)의 다음 시운전은 처음 고른 시나리오를 그대로 쓴다(비교 대상마다·수정 뒤 2회차)", async () => {
  // 가짜 Claude: 첫 시나리오 요청에만 답하고, 그 뒤로는 500. 다시 고르면 규칙 둘러보기로 바뀌어 회차끼리 비교가 어긋난다.
  let calls = 0;
  const claude = await fakeClaude((res, seen) => (++calls === 1 ? answered(aiSteps(["language"])) : json(500, { type: "error", error: { type: "api_error", message: "boom" } }))(res, seen));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const baseline = (await app()).url;
  const first = await waitDone(base, (await post(base, request(baseline, (await app()).url, { hints: { health_path: "/healthz" } }))).body.shakedown_id);
  assert.equal(first.scenario_source, "ai");

  const again = await waitDone(base, (await post(base, request(baseline, (await app()).url, { hints: { health_path: "/healthz" } }))).body.shakedown_id);
  assert.deepEqual([again.scenario, again.scenario_source], [first.scenario, "ai"]);
  // 다시 부르지 않았으니 이번 시운전의 AI 비용은 0이다(엔진이 회차마다 더한다).
  assert.deepEqual(again.ai_cost, { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 });
  assert.equal(claude.scenarioCalls().length, 1);

  // 다른 배포는 새로 고른다.
  const other = await waitDone(base, (await post(base, { ...request(baseline, (await app()).url), deployment_id: "dep_other" })).body.shakedown_id);
  assert.equal(other.scenario_source, "fallback");
  assert.equal(claude.scenarioCalls().length, 2);
});

test("기준 환경이 고른 시나리오를 통과하지 못했으면 다음 시운전에서 다시 쓰지 않는다", async () => {
  // 기준 환경: /flaky는 처음 한 번(미리 돌려 보기)만 200이고 그 뒤로 500이다.
  let flaky = 0;
  const baseline = await listen(createServer((req, res) => {
    if (req.url === "/flaky") return void res.writeHead(++flaky === 1 ? 200 : 500).end("flaky");
    res.writeHead(200, { "content-type": "application/json" }).end(`{"language":"node"}`);
  }));
  const scenario = {
    app_understanding: "A flaky page.",
    steps: [{ title: "Open the flaky page", action: "visit", path: "/flaky", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: [] } }],
  };
  let calls = 0;
  const claude = await fakeClaude((res, seen) => (++calls === 1 ? answered(scenario) : json(500, { type: "error", error: { type: "api_error", message: "boom" } }))(res, seen));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const first = await waitDone(base, (await post(base, request(baseline, (await app()).url))).body.shakedown_id);
  assert.equal(first.status, "failed");
  assert.match(first.error ?? "", /^baseline local failed at step 1 \(Open the flaky page\)/);

  const again = await waitDone(base, (await post(base, request(baseline, (await app()).url))).body.shakedown_id);
  assert.equal(again.status, "done", again.error);
  assert.equal(again.scenario_source, "fallback");
});

test("다시 쓴 시나리오가 기준 환경에서 실패하면 버리고, 그다음 시운전은 새로 고른다", async () => {
  // 기준 환경: /flaky는 처음 두 번(미리 돌려 보기, 1회차 본 실행)만 200이고 그 뒤로 500이다.
  let flaky = 0;
  const baseline = await listen(createServer((req, res) => {
    if (req.url === "/flaky") return void res.writeHead(++flaky <= 2 ? 200 : 500).end("flaky");
    res.writeHead(200, { "content-type": "application/json" }).end(`{"language":"node"}`);
  }));
  const scenario = {
    app_understanding: "A flaky page.",
    steps: [{ title: "Open the flaky page", action: "visit", path: "/flaky", form_action: null, link_text: null, fields: [], expect: { path_startswith: null, text_contains: [] } }],
  };
  let calls = 0;
  const claude = await fakeClaude((res, seen) => (++calls === 1 ? answered(scenario) : json(500, { type: "error", error: { type: "api_error", message: "boom" } }))(res, seen));
  const base = await api({ aiScenario: { apiKey: AI_KEY, baseURL: claude.baseURL } });
  const run = async () => waitDone(base, (await post(base, request(baseline, (await app()).url))).body.shakedown_id);
  assert.equal((await run()).scenario_source, "ai");
  assert.equal((await run()).status, "failed");
  const third = await run();
  assert.equal(third.status, "done", third.error);
  assert.equal(third.scenario_source, "fallback");
});
