import { test, after } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { StepDiff } from "@shakedown/contracts";
import { ruleReport } from "../src/report.ts";
import { runShakedown } from "../src/shakedown.ts";
import type { Verdict } from "../src/verdict.ts";
import { startFakeBoard, type FakeBoardOptions } from "./fake-board.ts";

const withNames = (steps: unknown[]) => (steps as StepDiff[]).map((d) => ({ ...d, baseline: "local", candidate: "aws" }));

// fixture 시도 1과 같은 상황(서버 2대, 세션 공유 없음)에서 나와야 하는 보고서. instance 근거만 빠졌다.
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
    option: "sticky_sessions",
    value: "true",
    description: "Pin each user to one instance (session affinity).",
    native: "nginx upstream ip_hash (on AWS: ALB target-group stickiness, or App Runner auto scaling max size 1 since it has no stickiness; on Cloud Run: --session-affinity)",
    auto_applicable: false,
  },
  confidence: "high",
  by: "rule",
};

test("fixture 시도 1(로그인 풀림)에서 fixture와 같은 원인·수정안을 낸다", () => {
  const report = ruleReport(withNames(fixture.attempts[0].steps), fixture.attempts[0].verdict as Verdict);
  assert.deepEqual(report, loginLost);

  // fixture와 다른 곳은 두 군데뿐이다.
  // native: fixture는 nginx 시뮬레이션 기준이고, 여기선 App Runner에 스티키 세션이 없다는 점을 덧붙였다.
  // auto_applicable: 지금 어느 대상도 sticky_sessions를 실제로 적용하지 못해서 false로 둔다.
  const expected = fixture.attempts[0].report!;
  const { native: _, auto_applicable: _auto, ...expectedFix } = expected.fix;
  const { native: __, auto_applicable, ...fix } = report!.fix!;
  assert.deepEqual(fix, expectedFix);
  assert.equal(auto_applicable, false);
  assert.deepEqual([report!.confidence, report!.by], [expected.confidence, expected.by]);
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
      value: "use the shared database (RDS) via SPRING_DATASOURCE_URL",
      description: "Point every instance at one persistent database instead of an embedded one.",
      native: "App Runner env var SPRING_DATASOURCE_URL → RDS endpoint",
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
      native: "application.yml spring.datasource.url: ${SPRING_DATASOURCE_URL} (App Runner env var → RDS endpoint)",
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
