import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { Report, StepDiff } from "@shakedown/contracts";
import { aiOptionsFromEnv, aiReport } from "../src/ai-report.ts";
import { ruleReport } from "../src/report.ts";
import { judge } from "../src/verdict.ts";

// 진짜 키가 아니다. 가짜 서버로만 간다.
const KEY = "sk-ant-test-dummy";
const withNames = (steps: unknown[]) => (steps as StepDiff[]).map((d) => ({ ...d, baseline: "local", candidate: "aws" }));
const blocked = withNames(fixture.attempts[0].steps);
const passed = withNames(fixture.attempts[1].steps);
const rule = fixture.attempts[0].report as Report;
const hints = { options: fixture.attempts[0].options };
const input = { diffs: blocked, verdict: judge(blocked), fallback: rule, hints };
const zero = { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 };
const billed = { calls: 1, input_tokens: 1000, output_tokens: 500, krw: 19.6 };

const answer = {
  headline: "Login is lost on aws because requests reach different instances",
  cause: "The app keeps the login in server memory and aws runs 2 instances without session affinity.",
  evidence: ["Step 4 ended on /board on local but on / on aws.", "aws hops: POST /login 302, GET /board 302, GET / 200"],
  fix: {
    target: "aws",
    option: "sticky_sessions",
    value: "true",
    description: "Pin each user to one instance.",
    native: "ALB target-group stickiness",
    auto_applicable: true,
  },
  confidence: "high",
};

// 실제 Messages API 응답 모양. Opus 5.5는 생각을 끌 수 없어서 thinking 블록이 text 앞에 온다.
function message(
  content: Anthropic.Beta.Messages.BetaContentBlock[],
  stop_reason: Anthropic.Beta.Messages.BetaStopReason = "end_turn",
  stop_details: Anthropic.Beta.Messages.BetaRefusalStopDetails | null = null,
): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: "msg_fake_01",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: null,
    },
  };
}
const thinking: Anthropic.Beta.Messages.BetaThinkingBlock = { type: "thinking", thinking: "", signature: "sig_fake" };
const textBlock = (text: string): Anthropic.Beta.Messages.BetaTextBlock => ({ type: "text", text, citations: null });
const answered = (body: unknown) => message([thinking, textBlock(JSON.stringify(body))]);

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: any };
type Reply = (res: ServerResponse) => void;
const json = (status: number, body: unknown): Reply => (res) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

async function fake(t: TestContext, reply: Reply) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: JSON.parse(raw) });
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

// 규칙 수정안이 제안만인 경우(엔진이 적용할 수 없는 대상). 이때는 AI의 수정안을 그대로 쓴다.
const manual = { ...input, fallback: { ...rule, fix: { ...rule.fix!, auto_applicable: false } } };

test("올바른 구조화 응답이면 by ai 보고서와 토큰 비용을 돌려준다", async (t) => {
  const f = await fake(t, json(200, answered(answer)));
  const result = await aiReport(manual, { apiKey: KEY, baseURL: f.baseURL });
  // AI가 auto_applicable을 true로 보내도 사람이 확인하도록 false로 바꾼다.
  assert.deepEqual(result, { report: { ...answer, fix: { ...answer.fix, auto_applicable: false }, by: "ai" }, cost: billed });
});

test("fix가 null인 응답도 받아들인다", async (t) => {
  const f = await fake(t, json(200, answered({ ...answer, fix: null })));
  const { report } = await aiReport(manual, { apiKey: KEY, baseURL: f.baseURL });
  assert.deepEqual(report, { ...answer, fix: null, by: "ai" });
});

test("규칙 fix가 auto_applicable이면 AI 문장은 쓰되 fix는 규칙 것을 그대로 둔다", async (t) => {
  // fixture의 규칙 수정안은 엔진이 자동으로 적용할 수 있는 env 변경이다.
  assert.equal(rule.fix?.auto_applicable, true);
  for (const fix of [answer.fix, null]) {
    const f = await fake(t, json(200, answered({ ...answer, fix })));
    const result = await aiReport(input, { apiKey: KEY, baseURL: f.baseURL });
    assert.deepEqual(result, { report: { ...answer, fix: rule.fix, by: "ai" }, cost: billed });
  }
});

test("규칙 fix를 고정해도 confidence는 AI 것을 쓴다(AI 자신의 원인 설명에 대한 확신이라서)", async (t) => {
  // 규칙과 같은 값이면 어느 쪽을 썼는지 구분되지 않으므로 규칙(high)과 다른 값으로 확인한다.
  assert.equal(rule.confidence, "high");
  const f = await fake(t, json(200, answered({ ...answer, confidence: "low" })));
  const { report } = await aiReport(input, { apiKey: KEY, baseURL: f.baseURL });
  assert.deepEqual(report, { ...answer, confidence: "low", fix: rule.fix, by: "ai" });
});

test("규칙 수정안이 그대로 적용된다는 것을 AI에게 알려 원인 문장이 그 수정안과 어긋나지 않게 한다", async (t) => {
  const f = await fake(t, json(200, answered(answer)));
  await aiReport(input, { apiKey: KEY, baseURL: f.baseURL });
  assert.match(f.seen[0].body.system, /If rule_report\.fix\.auto_applicable is true, that fix is applied as is/);
});

test("요청: POST /v1/messages, claude-opus-5-5, output_config.format, fallback 베타 헤더와 fallbacks default", async (t) => {
  const f = await fake(t, json(200, answered(answer)));
  await aiReport(input, { apiKey: KEY, baseURL: f.baseURL });

  assert.equal(f.seen.length, 1);
  const [req] = f.seen;
  assert.equal(req.method, "POST");
  assert.equal(new URL(req.url, f.baseURL).pathname, "/v1/messages");
  assert.equal(req.headers["x-api-key"], KEY);
  assert.ok(String(req.headers["anthropic-beta"]).split(",").includes("server-side-fallback-2026-07-01"));
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  assert.equal(req.body.max_tokens, 4000);
  assert.equal(req.body.output_config.effort, "low");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.deepEqual(req.body.output_config.format.schema.required, ["headline", "cause", "evidence", "fix", "confidence"]);
  assert.deepEqual(req.body.output_config.format.schema.properties.confidence.enum, ["high", "medium", "low"]);
  // betas는 헤더로만 가고, Opus 5.5에서 끌 수 없는 thinking은 보내지 않는다. 옛 output_format도 쓰지 않는다.
  assert.equal(req.body.betas, undefined);
  assert.equal(req.body.thinking, undefined);
  assert.equal(req.body.output_format, undefined);
  assert.equal(typeof req.body.system, "string");

  const data = JSON.parse(req.body.messages[0].content);
  assert.deepEqual(data.diverging_steps.map((s: { index: number }) => s.index), [4, 5, 6, 7, 8]);
  assert.deepEqual(data.diverging_steps[0], {
    index: 4,
    title: "Sign in",
    kind: "path_diff",
    reasons: ["ended on /board (local) vs / (cloud)"],
    baseline: { env: "local", final_path: "/board", final_status: 200, failed_checks: [] },
    candidate: {
      env: "aws",
      final_path: "/",
      final_status: 200,
      failed_checks: [],
      // 응답 서버 ID를 원본 hop에 붙여 AI가 rule_report 문장이 아니라 데이터에서 직접 근거를 댈 수 있게 한다.
      hops: ["POST /login 302 [172.23.0.3:8080]", "GET /board 302 [172.23.0.4:8080]", "GET / 200 [172.23.0.3:8080]"],
    },
  });
  assert.deepEqual(data.diverging_steps[1].candidate.failed_checks, ["ended on /, expected /write"]);
  assert.deepEqual(data.rule_report, rule);
  assert.deepEqual(data.hints, hints);
});

// 실제 규칙 보고서(fixture 데이터로 만든 것)에는 서버 전환 근거 줄이 있다. AI가 evidence를 다시 쓰면서 이 줄을 빠뜨릴 수 있다.
const ruled = ruleReport(blocked, judge(blocked))!;
const switched =
  "POST /login was handled by instance 172.23.0.3:8080, GET /board by instance 172.23.0.4:8080: 2 different instances served one user's requests.";
const aiFix = { ...answer.fix, auto_applicable: false };

test("AI evidence에 규칙 보고서의 instance 근거 줄이 그대로 없으면 끝에 붙인다", async (t) => {
  assert.equal(ruled.evidence.at(-1), switched);
  const oneId = [...answer.evidence, "GET /board was answered by 172.23.0.4:8080."];
  // 두 ID를 다른 말로 다 적었어도 붙인다. AI 글에서 ID 언급을 찾으면 짧은 ID가 302 같은 글에 잘못 걸리기 때문이다.
  const paraphrased = ["POST /login reached 172.23.0.3:8080 but GET /board reached 172.23.0.4:8080."];
  for (const evidence of [answer.evidence, oneId, paraphrased]) {
    const f = await fake(t, json(200, answered({ ...answer, evidence })));
    const { report } = await aiReport({ ...input, fallback: ruled }, { apiKey: KEY, baseURL: f.baseURL });
    assert.deepEqual(report, { ...answer, evidence: [...evidence, switched], fix: aiFix, by: "ai" });
  }
});

test("AI evidence에 같은 instance 근거 줄이 이미 있으면 다시 붙이지 않는다", async (t) => {
  const evidence = [...answer.evidence, switched];
  const f = await fake(t, json(200, answered({ ...answer, evidence })));
  const { report } = await aiReport({ ...input, fallback: ruled }, { apiKey: KEY, baseURL: f.baseURL });
  assert.deepEqual(report, { ...answer, evidence, fix: aiFix, by: "ai" });
});

test("서버 ID에 공백·쉼표가 있거나 아주 짧아도 instance 근거 줄을 지킨다", async (t) => {
  // 서버 ID는 외부 앱이 정하는 아무 문자열이다(계약 Hop.instance: string|null). 헤더가 두 번 오면 fetch가 ", "로 이어 붙인다.
  const cases = [
    ["web 1", "web 2"],
    ["172.23.0.3:8080, proxy", "172.23.0.4:8080, proxy"],
    ["1", "2"],
  ];
  // "1"과 "2"가 302·"1 second"의 일부로 들어 있지만 서버를 말한 게 아니다.
  const evidence = ["Step 4 (Sign in) ended on / after HTTP 302 within 1 second."];
  for (const [a, b] of cases) {
    const rename: Record<string, string> = { "172.23.0.3:8080": a, "172.23.0.4:8080": b };
    const diffs = blocked.map((d) => ({ ...d, cloud: { ...d.cloud, hops: d.cloud.hops.map((h) => ({ ...h, instance: rename[h.instance!] })) } }));
    const fallback = ruleReport(diffs, judge(diffs))!;
    const line = `POST /login was handled by instance ${a}, GET /board by instance ${b}: 2 different instances served one user's requests.`;
    assert.equal(fallback.evidence.at(-1), line);
    const f = await fake(t, json(200, answered({ ...answer, evidence })));
    const { report } = await aiReport({ ...input, diffs, fallback }, { apiKey: KEY, baseURL: f.baseURL });
    assert.deepEqual(report?.evidence, [...evidence, line], `${a} / ${b}`);
  }
});

test("JSON이 아닌 응답이면 규칙 보고서로 대체하고 받은 토큰은 센다", async (t) => {
  const f = await fake(t, json(200, message([thinking, textBlock("The cause is sticky sessions {")])));
  assert.deepEqual(await aiReport(input, { apiKey: KEY, baseURL: f.baseURL }), { report: rule, cost: billed });
});

const { confidence: _c, ...noConfidence } = answer;
const { fix: _f, ...noFix } = answer;
const { auto_applicable: _a, ...fixNoAuto } = answer.fix;
const invalid: Record<string, unknown> = {
  "confidence 없음": noConfidence,
  "confidence가 목록 밖": { ...answer, confidence: "certain" },
  "fix 키 없음": noFix,
  "fix에 auto_applicable 없음": { ...answer, fix: fixNoAuto },
  "auto_applicable이 문자열": { ...answer, fix: { ...answer.fix, auto_applicable: "true" } },
  "evidence가 문자열 배열이 아님": { ...answer, evidence: [1] },
  "headline이 문자열이 아님": { ...answer, headline: null },
  "최상위가 배열": [answer],
};
for (const [name, body] of Object.entries(invalid)) {
  test(`필드가 틀리면 규칙 보고서로 대체: ${name}`, async (t) => {
    const f = await fake(t, json(200, answered(body)));
    assert.deepEqual(await aiReport(input, { apiKey: KEY, baseURL: f.baseURL }), { report: rule, cost: billed });
  });
}

test("stop_reason refusal이면 규칙 보고서로 대체하고 받은 토큰은 센다", async (t) => {
  const details = {
    type: "refusal",
    category: "cyber",
    explanation: null,
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
  } as const;
  // 거절인데 text가 멀쩡해 보여도 쓰지 않는다.
  const f = await fake(t, json(200, message([textBlock(JSON.stringify(answer))], "refusal", details)));
  assert.deepEqual(await aiReport(input, { apiKey: KEY, baseURL: f.baseURL }), { report: rule, cost: billed });
});

test("HTTP 500이면 규칙 보고서로 대체하고 비용은 0", async (t) => {
  const f = await fake(t, json(500, { type: "error", error: { type: "api_error", message: "boom" } }));
  const client = new Anthropic({ apiKey: KEY, baseURL: f.baseURL, maxRetries: 0 });
  assert.deepEqual(await aiReport(input, { client }), { report: rule, cost: zero });
  assert.equal(f.seen.length, 1);
});

test("응답이 timeoutMs보다 늦으면 재시도 없이 규칙 보고서로 대체한다", async (t) => {
  const f = await fake(t, () => {});
  const started = Date.now();
  assert.deepEqual(await aiReport(input, { apiKey: KEY, baseURL: f.baseURL, timeoutMs: 200 }), { report: rule, cost: zero });
  assert.equal(f.seen.length, 1);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("키가 없으면 호출하지 않고 규칙 보고서를 돌려준다", async (t) => {
  const f = await fake(t, json(200, answered(answer)));
  assert.deepEqual(await aiReport(input, { baseURL: f.baseURL }), { report: rule, cost: zero });
  assert.equal(f.seen.length, 0);
});

test("ANTHROPIC_API_KEY가 있으면 켜고, SHAKEDOWN_AI_REPORT=off면 키가 있어도 끈다", async (t) => {
  assert.deepEqual(aiOptionsFromEnv({ ANTHROPIC_API_KEY: KEY }), { apiKey: KEY });
  assert.deepEqual(aiOptionsFromEnv({}), {});

  const off = aiOptionsFromEnv({ ANTHROPIC_API_KEY: KEY, SHAKEDOWN_AI_REPORT: "off" });
  assert.deepEqual(off, {});
  const f = await fake(t, json(200, answered(answer)));
  assert.deepEqual(await aiReport(input, { ...off, baseURL: f.baseURL }), { report: rule, cost: zero });
  assert.equal(f.seen.length, 0);
});

test("BLOCKED가 아니면 호출하지 않고 null을 돌려준다", async (t) => {
  const f = await fake(t, json(200, answered(answer)));
  const result = await aiReport({ diffs: passed, verdict: judge(passed), fallback: null }, { apiKey: KEY, baseURL: f.baseURL });
  assert.deepEqual(result, { report: null, cost: zero });
  assert.equal(f.seen.length, 0);
});
