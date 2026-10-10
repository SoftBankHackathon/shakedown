import { test, after } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { Hop, StepDiff } from "@shakedown/contracts";
import { ruleReport } from "../src/report.ts";
import { runShakedown } from "../src/shakedown.ts";
import type { Verdict } from "../src/verdict.ts";
import { startFakeBoard, type FakeBoardOptions } from "./fake-board.ts";

// 비교 대상 이름을 바꿔 가며 쓴다. 정답 fixture는 엔진이 실제로 env 수정을 적용하는 gcp 기록이다.
const withNames = (steps: unknown[], candidate = "aws") => (steps as StepDiff[]).map((d) => ({ ...d, baseline: "local", candidate }));

// fixture 시도 1과 같은 상황(서버 2대, 세션 공유 없음)에서 나와야 하는 보고서. 응답 서버 ID(instance)가 없을 때의 모양이다.
const loginLost = {
  headline: "Login is lost on aws: requests land on different instances",
  cause:
    "The app keeps the login in server memory (HttpSession). aws runs more than one instance behind a load balancer " +
    "without session affinity, so the request after login reaches an instance that never saw it.",
  evidence: [
    "Step 4 (Sign in) worked on local (ended on /board) but not on aws (ended on /).",
    "aws hops: POST /login 302 → GET /board 302 → GET / 200",
    "aws sent GET /board back to the sign-in page (/) right after POST /login; local did not.",
  ],
  fix: {
    target: "aws",
    option: "env",
    value: "SPRING_PROFILES_ACTIVE=demo,session-jdbc",
    description: "Keep the login in the shared database (Spring Session JDBC) so every instance sees it.",
    native: "Cloud Run / ECS env SPRING_PROFILES_ACTIVE=demo,session-jdbc (sessions in the spring_session table of Cloud SQL / RDS)",
    auto_applicable: false,
  },
  confidence: "high",
  by: "rule",
};

// fixture hop에는 X-Instance-Id가 있다. 로그인(POST /login)과 튕긴 요청(GET /board)을 받은 서버가 다르다는 근거 한 줄이 붙는다.
const switched =
  "POST /login was handled by instance 172.23.0.3:8080, GET /board by instance 172.23.0.4:8080: 2 different instances served one user's requests.";

test("fixture 시도 1(로그인 풀림)에서 fixture와 같은 원인·수정안을 낸다", () => {
  const report = ruleReport(withNames(fixture.attempts[0].steps), fixture.attempts[0].verdict as Verdict);
  assert.deepEqual(report, { ...loginLost, evidence: [...loginLost.evidence, switched] });

  // 같은 기록을 fixture처럼 gcp 이름으로 돌리면 fixture와 다른 곳은 auto_applicable 하나뿐이다.
  // 엔진이 env를 바꿔 다시 배포할 수 있다는 힌트(can_apply_env)가 없으면 제안만 하므로 false다.
  const expected = fixture.attempts[0].report!;
  const onGcp = ruleReport(withNames(fixture.attempts[0].steps, "gcp"), fixture.attempts[0].verdict as Verdict);
  const { auto_applicable: _auto, ...expectedFix } = expected.fix;
  const { auto_applicable, ...fix } = onGcp!.fix!;
  assert.deepEqual(fix, expectedFix);
  assert.equal(auto_applicable, false);
  assert.deepEqual([report!.confidence, report!.by], [expected.confidence, expected.by]);
});

test("env를 바꿀 수 있는 대상이면 로그인 풀림 수정안은 fixture와 같은 session-jdbc env 변경이고 자동 적용 가능", () => {
  const report = ruleReport(withNames(fixture.attempts[0].steps, "gcp"), fixture.attempts[0].verdict as Verdict, { canApplyEnv: true });
  assert.deepEqual(report!.fix, fixture.attempts[0].report!.fix);
  assert.deepEqual(report!.fix, fixture.attempts[0].applied_fix);
});

const hop = (method: string, path: string, status: number, instance: string | null): Hop => ({ method, path, status, instance });

// 실제 Cloud Run E2E 모양: 로그인은 4단계에서 끝났고(같은 서버가 받아 통과), 5단계도 통과, 6단계에서 다른 서버로 가서 튕겼다.
// 그래서 로그인 hop은 처음 달라진 단계가 아니라 앞 단계에서 찾아야 한다.
function laterBounce(loginStep: Hop[], bounceStep: Hop[]) {
  const steps = withNames(fixture.attempts[1].steps);
  // 매개변수를 steps 원소 타입으로 받아야 baseline·candidate가 string으로 남아 steps[i]에 다시 넣을 수 있다.
  const passed = (d: (typeof steps)[number], hops: Hop[]) => ({ ...d, cloud: { ...d.cloud, hops } });
  steps[3] = passed(steps[3], loginStep);
  steps[4] = passed(steps[4], [hop("GET", "/write", 200, loginStep[0].instance)]);
  steps[5] = {
    ...steps[5],
    kind: "path_diff",
    severity: "critical",
    reasons: ["ended on /board (local) vs / (aws)"],
    cloud: { ...steps[5].cloud, final_path: "/", final_status: 200, hops: bounceStep },
  };
  return ruleReport(steps, { status: "BLOCKED", first_divergence: 6, summary: "" });
}

function loginThenLaterBounce(instances: { login: string | null; write: string | null; board: string | null }) {
  return laterBounce(
    [hop("POST", "/login", 302, instances.login), hop("GET", "/board", 200, instances.login)],
    [hop("POST", "/api/posts/write", 302, instances.write), hop("GET", "/board", 302, instances.board), hop("GET", "/", 200, instances.write)],
  );
}

test("로그인이 앞 단계에서 끝났으면 그 단계의 POST /login 서버와 튕긴 요청의 서버를 근거로 댄다", () => {
  const report = loginThenLaterBounce({ login: "i-aaaa1111", write: "i-aaaa1111", board: "i-bbbb2222" });
  assert.equal(report?.headline, "Login is lost on aws: requests land on different instances");
  assert.deepEqual(report?.evidence.slice(-2), [
    "aws sent GET /board back to the sign-in page (/) right after POST /api/posts/write; local did not.",
    "POST /login was handled by instance i-aaaa1111, GET /board by instance i-bbbb2222: 2 different instances served one user's requests.",
  ]);
  assert.equal(report?.confidence, "high");
});

test("로그인과 튕긴 요청의 서버 ID가 같거나 없으면 instance 근거를 붙이지 않는다", () => {
  for (const instances of [
    { login: "i-aaaa1111", write: "i-aaaa1111", board: "i-aaaa1111" },
    { login: null, write: null, board: null },
    { login: null, write: "i-aaaa1111", board: "i-bbbb2222" },
    // 튕긴 요청만 ID가 없을 때 붙이면 "by instance null"이라는 틀린 주장이 된다.
    { login: "i-aaaa1111", write: "i-aaaa1111", board: null },
  ]) {
    const report = loginThenLaterBounce(instances);
    assert.equal(report?.evidence.at(-1), "aws sent GET /board back to the sign-in page (/) right after POST /api/posts/write; local did not.");
    assert.equal(report?.confidence, "high");
  }
});

test("로그인 hop은 튕긴 hop보다 앞에 있는 POST 로그인 중 마지막 것이다", () => {
  const login = [hop("POST", "/login", 302, "i-aaaa1111"), hop("GET", "/board", 200, "i-aaaa1111")];
  // 튕기기 직전에 다시 로그인했으면 4단계의 옛 로그인이 아니라 방금 로그인을 받은 서버를 댄다.
  const relogin = laterBounce(login, [
    hop("POST", "/login", 302, "i-cccc3333"),
    hop("GET", "/board", 302, "i-bbbb2222"),
    hop("GET", "/", 200, "i-cccc3333"),
  ]);
  assert.equal(
    relogin?.evidence.at(-1),
    "POST /login was handled by instance i-cccc3333, GET /board by instance i-bbbb2222: 2 different instances served one user's requests.",
  );
  // 튕긴 hop이 POST 로그인 자신이면 비교 대상에서 뺀다. 자기 자신과 비교하면 늘 같은 서버라서 근거가 사라진다.
  const bouncedLogin = laterBounce(login, [hop("POST", "/login", 302, "i-bbbb2222"), hop("GET", "/", 200, "i-bbbb2222")]);
  assert.equal(
    bouncedLogin?.evidence.at(-1),
    "POST /login was handled by instance i-aaaa1111, POST /login by instance i-bbbb2222: 2 different instances served one user's requests.",
  );
});

// 둘러보기 시나리오(visit만)의 한 단계. 기준 환경은 그 화면에 머물고, 비교 환경은 hops대로 끝난다.
function crawlStep(path: string, cloudHops: Hop[]): StepDiff {
  const result = (finalPath: string, hops: Hop[]) => ({
    index: 1, title: `Open ${path}`, status: "passed" as const, error: null, final_path: finalPath, final_status: 200, hops,
    checks: [{ name: "http", ok: true, detail: "HTTP 200" }], elapsed_ms: 1,
  });
  return {
    index: 1, baseline: "local", candidate: "aws", title: `Open ${path}`,
    local: result(path, [hop("GET", path, 200, null)]),
    cloud: result(cloudHops.at(-1)!.path, cloudHops),
    kind: "path_diff", severity: "critical", reasons: [`ended on ${path} (local) vs / (aws)`], classified_by: "rule",
  };
}

test("로그인한 적이 없는데 \"/\"로 돌아간 것은 로그인 풀림이 아니다(게시판이 아닌 앱의 둘러보기)", () => {
  const d = crawlStep("/dashboard", [hop("GET", "/dashboard", 302, null), hop("GET", "/", 200, null)]);
  const report = ruleReport([d], { status: "BLOCKED", first_divergence: 1, summary: "" });
  assert.equal(report?.headline, "Step 1 (Open /dashboard) differs between local and aws");
  assert.equal(report?.fix, null);
});

test("튕긴 hop 자체가 로그인 POST면 앞에 다른 로그인이 없어도 로그인 풀림이다", () => {
  const d = crawlStep("/board", [hop("POST", "/login", 302, null), hop("GET", "/", 200, null)]);
  const report = ruleReport([d], { status: "BLOCKED", first_divergence: 1, summary: "" });
  assert.equal(report?.headline, "Login is lost on aws: requests land on different instances");
});

test("로그인 주소가 /login이 아닌 앱(/signin, /auth/login, /api/login, /session)도 로그인 POST 뒤 튕기면 로그인 풀림이다", () => {
  for (const login of ["/signin", "/auth/login", "/api/login", "/session"]) {
    const d = crawlStep("/board", [hop("POST", login, 302, null), hop("GET", "/board", 302, null), hop("GET", "/login", 200, null)]);
    const report = ruleReport([d], { status: "BLOCKED", first_divergence: 1, summary: "" });
    assert.equal(report?.headline, "Login is lost on aws: requests land on different instances", login);
  }
  // 글쓴이(/author)·가입(/auth/register)·세션 하위 자원은 로그인이 아니다. 로그인 칸은 주소의 마지막 칸이어야 한다.
  for (const notLogin of ["/author", "/auth/register", "/api/sessions/1/messages"]) {
    const d = crawlStep("/board", [hop("POST", notLogin, 302, null), hop("GET", "/board", 302, null), hop("GET", "/login", 200, null)]);
    assert.equal(ruleReport([d], { status: "BLOCKED", first_divergence: 1, summary: "" })?.headline, "Step 1 (Open /board) differs between local and aws", notLogin);
  }
});

test("밑줄 로그인 주소(/users/sign_in)와 /login이 아닌 로그인 화면(/signin, /auth/login)으로 튕긴 것도 로그인 풀림이다", () => {
  for (const [login, page] of [
    ["/users/sign_in", "/users/sign_in"], ["/signin", "/signin"], ["/auth/login", "/auth/login"],
    // Spring Security의 로그인 처리 주소
    ["/perform_login", "/login"], ["/j_spring_security_check", "/login"],
  ]) {
    const d = crawlStep("/dashboard", [hop("POST", login, 302, null), hop("GET", "/dashboard", 302, null), hop("GET", page, 200, null)]);
    const report = ruleReport([d], { status: "BLOCKED", first_divergence: 1, summary: "" });
    assert.equal(report?.headline, "Login is lost on aws: requests land on different instances", `${login} → ${page}`);
  }
});

test("두 환경 모두 \"/\"에서 끝났는데 쓴 글이 비교 환경에서만 안 보이면 데이터 유실이다(\"/\"가 로그인 화면이 아닌 앱)", () => {
  const result = (shown: boolean) => ({
    index: 2, title: "Check the note", status: shown ? "passed" as const : "failed" as const, error: shown ? null : "'note abc' not shown",
    final_path: "/", final_status: 200, hops: [hop("GET", "/", 200, null)],
    checks: [{ name: "http", ok: true, detail: "HTTP 200" }, { name: "text", ok: shown, detail: shown ? "'note abc' shown" : "'note abc' not shown" }], elapsed_ms: 1,
  });
  const d: StepDiff = {
    index: 2, baseline: "local", candidate: "aws", title: "Check the note", local: result(true), cloud: result(false),
    kind: "env_diff", severity: "critical", reasons: ["passed on local, failed on aws"], classified_by: "rule",
  };
  assert.equal(ruleReport([d], { status: "BLOCKED", first_divergence: 2, summary: "" })?.headline, "Data is lost on aws: what was just written does not come back");
});

test("fixture 시도 2(PASS)에는 보고서가 없다", () => {
  assert.equal(ruleReport(withNames(fixture.attempts[1].steps), fixture.attempts[1].verdict as Verdict), null);
});

test("링크를 못 찾은 실패는 'request failed:'로 시작해도 접속 실패가 아니라 데이터 유실로 본다", () => {
  const steps = withNames(fixture.attempts[1].steps);
  const error = 'request failed: link "[shakedown] post 9d2cf2" not found on the current page';
  steps[6] = { ...steps[6], kind: "env_diff", severity: "critical", cloud: { ...steps[6].cloud, status: "failed", error, final_path: null, final_status: null, hops: [], checks: [] } };
  const report = ruleReport(steps, { status: "BLOCKED", first_divergence: 7, summary: "" });
  assert.equal(report?.headline, "Data is lost on aws: what was just written does not come back");
  assert.deepEqual(report?.evidence, [`Step 7 (Open the new post) worked on local (ended on /posts/11) but not on aws (${error}).`]);
});

const boards: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(boards.map((b) => b.close())));

async function shakedown(candidate: FakeBoardOptions) {
  const base = await startFakeBoard();
  const cand = await startFakeBoard(candidate);
  boards.push(base, cand);
  const result = await runShakedown({ baseline: { name: "local", url: base.url }, candidate: { name: "aws", url: cand.url }, runId: "abc123" });
  return ruleReport(result.steps, result.verdict);
}

test("두 환경이 같으면 보고서가 없다", async () => {
  assert.equal(await shakedown({}), null);
});

test("이야기 1: 비교 환경이 꺼져 있으면 접속 불가", async () => {
  const base = await startFakeBoard();
  const down = await startFakeBoard();
  boards.push(base);
  await down.close();
  const result = await runShakedown({ baseline: { name: "local", url: base.url }, candidate: { name: "aws", url: down.url }, timeoutMs: 2000 });
  const report = ruleReport(result.steps, result.verdict);
  assert.equal(report?.headline, "aws is not reachable");
  assert.match(report!.cause, /^The request to aws failed before any HTTP response came back/);
  assert.match(report!.evidence[0], /^Step 1 \(Open sign-up page\) worked on local \(ended on \/join\) but not on aws \(request failed: /);
  assert.deepEqual([report?.fix, report?.confidence, report?.by], [null, "high", "rule"]);
});

test("이야기 2: 서버 2대에 세션을 나눠 두면 로그인 풀림", async () => {
  assert.deepEqual(await shakedown({ instances: 2 }), loginLost);
});

test("이야기 3: 세션은 공유돼도 글 저장소가 서버마다 따로면 데이터 유실", async () => {
  assert.deepEqual(await shakedown({ instances: 2, sharedSessions: true, sharedPosts: false }), {
    headline: "Data is lost on aws: what was just written does not come back",
    cause:
      "aws accepted the write but did not show it afterwards, while local did. Writes are not persisted or not shared on aws: " +
      "it may use an in-memory/embedded DB, a separate DB per instance, or a DB that is reset on restart.",
    evidence: [
      "Step 6 (Publish a post) worked on local (ended on /board) but not on aws (ended on /board, '[shakedown] post abc123' not shown).",
      "aws hops: POST /api/posts/write 302 → GET /board 200",
    ],
    fix: {
      target: "aws",
      option: "code_change",
      value: "point every instance at one shared managed database via an env var (e.g. DATABASE_URL, SPRING_DATASOURCE_URL)",
      description: "Point every instance at one persistent database instead of an embedded one.",
      native: "Cloud Run / ECS / Container Apps env var (e.g. DATABASE_URL, SPRING_DATASOURCE_URL) → shared managed DB (Cloud SQL / RDS / Azure Database)",
      auto_applicable: false,
    },
    confidence: "medium",
    by: "rule",
  });
});

test("이야기 4: 회원가입이 500이면 서버 오류(DB 설정)", async () => {
  assert.deepEqual(await shakedown({ failJoin: 500 }), {
    headline: "aws fails with a server error (HTTP 500)",
    cause:
      "aws answered step 2 (Create a test account) with HTTP 500 where local worked. " +
      "A server error that only shows up after deploying is most often the database connection or config, " +
      "e.g. a DB URL hard-coded to localhost that does not exist on aws.",
    evidence: [
      "Step 2 (Create a test account) worked on local (ended on /) but not on aws (ended on /join, HTTP 500).",
      "aws hops: POST /join 500",
    ],
    fix: {
      target: "aws",
      option: "code_change",
      value: "move the DB URL to environment variables",
      description: "Read the DB URL, user and password from environment variables instead of hard-coding them.",
      native:
        "read the DB URL from an env var (e.g. DATABASE_URL; in Spring spring.datasource.url: ${SPRING_DATASOURCE_URL}) " +
        "set on Cloud Run / ECS / Container Apps to the managed DB (Cloud SQL / RDS / Azure Database)",
      auto_applicable: false,
    },
    confidence: "medium",
    by: "rule",
  });
});

test("이야기 5: 알려진 원인이 아니면 처음 달라진 단계로 일반 보고서", async () => {
  assert.deepEqual(await shakedown({ failJoin: 400 }), {
    headline: "Step 2 (Create a test account) differs between local and aws",
    cause:
      "The first difference is at step 2 (Create a test account): passed on local, failed on aws; HTTP 400; ended on / (local) vs /join (aws). " +
      "It does not match a known cause (unreachable, lost login, lost data, server error), so read the hops below.",
    evidence: ["Step 2 (Create a test account): local ended on /; aws ended on /join, HTTP 400.", "aws hops: POST /join 400"],
    fix: null,
    confidence: "low",
    by: "rule",
  });
});
