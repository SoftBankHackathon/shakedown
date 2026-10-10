import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrawledPage } from "../src/crawl.ts";
import { aiScenario, aiScenarioOptionsFromEnv } from "../src/ai-scenario.ts";
import { answered, json, message, startFakeClaude } from "./fake-claude.ts";

// 진짜 키가 아니다. 가짜 서버로만 간다.
const KEY = "sk-ant-test-dummy";
const zero = { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 };
const billed = { calls: 1, input_tokens: 1000, output_tokens: 500, krw: 19.6 };

const pages: CrawledPage[] = [
  {
    path: "/", final_path: "/", status: 200, title: "Notes", text: "Notes Sign up",
    links: [{ text: "Sign up", path: "/signup" }], forms: [], error: null,
  },
  {
    path: "/signup", final_path: "/signup", status: 200, title: "Sign up", text: "Sign up",
    links: [],
    forms: [{ action: "/signup", method: "POST", inputs: [{ name: "email", type: "email" }, { name: "password", type: "password" }, { name: "plan", type: "select" }] }],
    error: null,
  },
];
const hints = { health_path: "/healthz", uses_server_session: false };

const step = (over: Record<string, unknown>) => ({
  title: "Open home", action: "visit", path: "/", form_action: null, link_text: null, fields: [],
  expect: { path_startswith: null, text_contains: [] }, ...over,
});
const answer = {
  app_understanding: "A notes app where a visitor signs up.",
  steps: [
    step({}),
    step({ title: "Open sign-up page", path: "/signup", expect: { path_startswith: "/signup", text_contains: ["Sign up"] } }),
    step({
      title: "Create an account", action: "submit_form", path: null, form_action: "/signup",
      // 고르는 칸(select)은 고정값을 써도 된다. 둘러본 폼에서 그 칸의 종류를 봤다.
      fields: [{ name: "email", value: "{{email}}" }, { name: "password", value: "{{password}}" }, { name: "plan", value: "free" }],
      expect: { path_startswith: null, text_contains: ["{{email}}"] },
    }),
    step({ title: "Open the account page", action: "click_link", path: null, link_text: "My account" }),
  ],
};

test("올바른 시나리오를 받으면 계약 모양 그대로 돌려주고 토큰 비용을 센다", async (t) => {
  const f = await startFakeClaude(t, answered(answer));
  assert.deepEqual(await aiScenario({ pages, hints }, { apiKey: KEY, baseURL: f.baseURL }), { scenario: answer, cost: billed });
});

test("요청: claude-opus-5-5, 구조화 출력(시나리오 스키마), fallback 베타, 둘러본 페이지·hints와 자리표시자 목록", async (t) => {
  const f = await startFakeClaude(t, answered(answer));
  await aiScenario({ pages, hints }, { apiKey: KEY, baseURL: f.baseURL });
  assert.equal(f.seen.length, 1);
  const [req] = f.seen;
  assert.equal(new URL(req.url, f.baseURL).pathname, "/v1/messages");
  assert.ok(String(req.headers["anthropic-beta"]).split(",").includes("server-side-fallback-2026-07-01"));
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  assert.equal(req.body.output_config.effort, "low");
  assert.equal(req.body.output_config.format.type, "json_schema");
  const schema = req.body.output_config.format.schema;
  assert.deepEqual(schema.required, ["app_understanding", "steps"]);
  assert.deepEqual(schema.properties.steps.items.properties.action.enum, ["visit", "submit_form", "click_link"]);
  // 구조화 출력은 배열 길이 제한(maxItems)을 받지 않는다. 8단계 제한은 받은 뒤에 직접 검사한다.
  assert.equal(schema.properties.steps.maxItems, undefined);
  for (const placeholder of ["{{email}}", "{{nickname}}", "{{password}}", "{{title}}", "{{content}}", "{{comment}}"]) {
    assert.ok(req.body.system.includes(placeholder), placeholder);
  }
  assert.deepEqual(JSON.parse(req.body.messages[0].content), { pages, hints });
});

test("계약에 없는 키는 옮기지 않고, 빠진 선택 칸은 null·빈 배열로 채운다", async (t) => {
  const loose = {
    app_understanding: "x",
    note: "extra",
    steps: [{ title: "Open home", action: "visit", path: "/", fields: [], expect: { text_contains: [] }, comment: "extra" }],
  };
  const f = await startFakeClaude(t, answered(loose));
  const { scenario } = await aiScenario({ pages }, { apiKey: KEY, baseURL: f.baseURL });
  assert.deepEqual(scenario, { app_understanding: "x", steps: [step({})] });
});

const nine = Array.from({ length: 9 }, (_, i) => step({ title: `Open ${i}` }));
const invalid: Record<string, unknown> = {
  "단계가 8개를 넘음": { ...answer, steps: nine },
  "단계가 없음": { ...answer, steps: [] },
  // 미리 돌리기가 기준 환경에 먼저 쓰므로, 고정값으로 가입하면 본 실행 가입이 '이미 있음'으로 실패한다.
  "입력칸에 고정값": { ...answer, steps: [step({ action: "submit_form", path: null, form_action: "/signup", fields: [{ name: "email", value: "test@example.com" }] })] },
  "고르는 칸인지 모르는 칸에 고정값": { ...answer, steps: [step({ action: "submit_form", path: null, form_action: "/write", fields: [{ name: "plan", value: "{{title}}" }, { name: "tag", value: "news" }] })] },
  "모르는 자리표시자": { ...answer, steps: [step({ action: "submit_form", path: null, form_action: "/signup", fields: [{ name: "phone", value: "{{phone}}" }] })] },
  "visit 경로가 /로 시작하지 않음": { ...answer, steps: [step({ path: "signup" })] },
  "visit 경로가 다른 출처(//)": { ...answer, steps: [step({ path: "//evil.example/x" })] },
  "visit 경로가 다른 출처(역슬래시)": { ...answer, steps: [step({ path: "/\\evil.example/x" })] },
  // 환경마다 DB가 따로라 기준 환경의 글 1번이 비교 환경엔 없다. 규칙 둘러보기처럼 데이터 주소는 받지 않는다.
  "visit 경로가 데이터 주소": { ...answer, steps: [step({ path: "/posts/1" })] },
  // 쿼리도 규칙 둘러보기처럼 받지 않는다(?id=6·?page=2는 환경마다 없을 수 있다). 검색은 GET 폼(submit_form)으로 한다.
  "visit 경로에 쿼리": { ...answer, steps: [step({ path: "/item?id=6" })] },
  "visit 경로에 자리표시자 쿼리": { ...answer, steps: [step({ path: "/search?q={{title}}" })] },
  "visit 경로가 정적 파일": { ...answer, steps: [step({ path: "/app.js" })] },
  "기대 경로가 데이터 주소": { ...answer, steps: [step({ expect: { path_startswith: "/boards/5f8d0d55b54764421b7156c9", text_contains: [] } })] },
  "visit 경로가 전체 주소": { ...answer, steps: [step({ path: "https://evil.example/" })] },
  "submit_form에 form_action이 없음": { ...answer, steps: [step({ action: "submit_form", path: null })] },
  "click_link 글자가 비었음": { ...answer, steps: [step({ action: "click_link", path: null, link_text: "" })] },
  "로그아웃 링크": { ...answer, steps: [step({ action: "click_link", path: null, link_text: "Log out" })] },
  "삭제 폼": { ...answer, steps: [step({ action: "submit_form", path: null, form_action: "/notes/delete" })] },
  "관리자 화면": { ...answer, steps: [step({ path: "/admin/users" })] },
  "결제 폼": { ...answer, steps: [step({ action: "submit_form", path: null, form_action: "/checkout" })] },
  "모르는 action": { ...answer, steps: [step({ action: "scroll" })] },
  "fields가 문자열 쌍이 아님": { ...answer, steps: [step({ fields: [{ name: "email", value: 1 }] })] },
  "text_contains가 문자열 배열이 아님": { ...answer, steps: [step({ expect: { path_startswith: null, text_contains: [1] } })] },
  "app_understanding이 문자열이 아님": { ...answer, app_understanding: null },
};
for (const [name, body] of Object.entries(invalid)) {
  test(`쓸 수 없는 시나리오는 버리고 받은 토큰은 센다: ${name}`, async (t) => {
    const f = await startFakeClaude(t, answered(body));
    assert.deepEqual(await aiScenario({ pages }, { apiKey: KEY, baseURL: f.baseURL }), { scenario: null, cost: billed });
  });
}

test("숫자·날짜처럼 겹칠 일 없는 칸은 둘러본 폼에서 그 종류를 봤으면 고정값을 받는다", async (t) => {
  const order: CrawledPage = {
    path: "/order", final_path: "/order", status: 200, title: "Order", text: "",
    links: [], forms: [{ action: "/order", method: "POST", inputs: [{ name: "quantity", type: "number" }, { name: "day", type: "date" }, { name: "phone", type: "tel" }] }], error: null,
  };
  const submit = (fields: Array<{ name: string; value: string }>) =>
    ({ ...answer, steps: [step({}), step({ title: "Order", action: "submit_form", path: null, form_action: "/order", fields })] });
  const ok = await startFakeClaude(t, answered(submit([{ name: "quantity", value: "1" }, { name: "day", value: "2026-10-10" }])));
  assert.ok((await aiScenario({ pages: [...pages, order] }, { apiKey: KEY, baseURL: ok.baseURL })).scenario);
  // 전화번호는 계정마다 달라야 할 수 있어 고정값을 받지 않는다.
  const tel = await startFakeClaude(t, answered(submit([{ name: "phone", value: "010-0000-0000" }])));
  assert.equal((await aiScenario({ pages: [...pages, order] }, { apiKey: KEY, baseURL: tel.baseURL })).scenario, null);
});

test("JSON이 아니거나 거절(refusal)이면 버리고 받은 토큰은 센다", async (t) => {
  for (const reply of [json(200, message("Here is a scenario {")), json(200, message(JSON.stringify(answer), "refusal"))]) {
    const f = await startFakeClaude(t, reply);
    assert.deepEqual(await aiScenario({ pages }, { apiKey: KEY, baseURL: f.baseURL }), { scenario: null, cost: billed });
  }
});

test("HTTP 오류나 시간 초과면 재시도 없이 버리고 비용은 0", async (t) => {
  const failing = await startFakeClaude(t, json(500, { type: "error", error: { type: "api_error", message: "boom" } }));
  assert.deepEqual(await aiScenario({ pages }, { apiKey: KEY, baseURL: failing.baseURL }), { scenario: null, cost: zero });
  assert.equal(failing.seen.length, 1);

  const silent = await startFakeClaude(t, () => {});
  const started = Date.now();
  assert.deepEqual(await aiScenario({ pages }, { apiKey: KEY, baseURL: silent.baseURL, timeoutMs: 200 }), { scenario: null, cost: zero });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("시운전이 취소되면(마감) 기다리지 않고 버린다", async (t) => {
  const silent = await startFakeClaude(t, () => {});
  const controller = new AbortController();
  controller.abort(new Error("timed out after 150s"));
  const started = Date.now();
  assert.deepEqual(await aiScenario({ pages }, { apiKey: KEY, baseURL: silent.baseURL, signal: controller.signal }), { scenario: null, cost: zero });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("키가 없으면 부르지 않는다", async (t) => {
  const f = await startFakeClaude(t, answered(answer));
  assert.deepEqual(await aiScenario({ pages }, { baseURL: f.baseURL }), { scenario: null, cost: zero });
  assert.equal(f.seen.length, 0);
});

test("ANTHROPIC_API_KEY가 있으면 켜고, SHAKEDOWN_AI_SCENARIO=off만 끈다(SHAKEDOWN_AI_REPORT=off와 따로)", () => {
  assert.deepEqual(aiScenarioOptionsFromEnv({ ANTHROPIC_API_KEY: KEY }), { apiKey: KEY });
  assert.deepEqual(aiScenarioOptionsFromEnv({ ANTHROPIC_API_KEY: KEY, SHAKEDOWN_AI_REPORT: "off" }), { apiKey: KEY });
  assert.deepEqual(aiScenarioOptionsFromEnv({ ANTHROPIC_API_KEY: KEY, SHAKEDOWN_AI_SCENARIO: "off" }), {});
  assert.deepEqual(aiScenarioOptionsFromEnv({}), {});
});
