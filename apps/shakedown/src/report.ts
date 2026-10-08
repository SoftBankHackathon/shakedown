// 판정이 BLOCKED일 때 단계 비교 결과만 보고 원인 보고서를 만든다. AI는 쓰지 않는다.
// 데모 버그가 아직 정해지지 않아서 알려진 원인 넷을 정해진 순서로 확인하고, 아무것도 맞지 않으면 일반 보고서를 낸다.
// hop.instance는 응답 헤더로 기록된다. 아래 규칙의 원인 추정은 hop 경로를 기준으로 한다.
import type { Fix, Hop, Report, StepDiff, StepResult } from "@shakedown/contracts";
import { normalizePath } from "./compare.ts";
import type { Verdict } from "./verdict.ts";

/** 로그인 화면. kty-board는 "/"가 로그인 화면이다. */
function isSignIn(path: string | null): boolean {
  if (path === null) return false;
  const p = path.split("?")[0];
  return p === "/" || p.startsWith("/login");
}

function hopChain(hops: Hop[]): string {
  return hops.map((h) => `${h.method} ${h.path} ${h.status}`).join(" → ");
}

/** 한 환경에서 그 단계가 어떻게 끝났는지. 예: "ended on /board, 'x' not shown" */
function outcome(r: StepResult): string {
  if (r.final_path === null || r.error?.startsWith("ended on")) return r.error ?? r.status;
  return r.error ? `ended on ${r.final_path}, ${r.error}` : `ended on ${r.final_path}`;
}

// steps.ts는 폼·링크를 못 찾거나 리다이렉트가 너무 많을 때도 "request failed:"를 붙인다. 이건 접속 실패가 아니다.
function isUnreachable(r: StepResult): boolean {
  return (
    r.final_status === null &&
    r.error !== null &&
    r.error.startsWith("request failed:") &&
    !/not found on the current page|too many redirects/.test(r.error)
  );
}

/**
 * 기준 환경은 로그인이 필요한 화면에 머물렀는데 비교 환경만 로그인 화면으로 되돌려졌다면,
 * 되돌린 hop(로그인 직후의 POST, 또는 보호된 화면 GET)의 위치를 돌려준다. 없으면 -1.
 */
function signInBounce(d: StepDiff): number {
  if (d.local.status !== "passed" || isSignIn(d.local.final_path) || !isSignIn(d.cloud.final_path)) return -1;
  const hops = d.cloud.hops;
  return hops.findIndex((from, i) => {
    const to = hops[i + 1];
    return (
      to !== undefined && to.method === "GET" && isSignIn(to.path) &&
      from.status >= 300 && from.status < 400 &&
      (from.method === "POST" || !isSignIn(from.path))
    );
  });
}

/** 방금 쓴 값(글 제목·본문·댓글)이 비교 환경에서만 다시 보이지 않는다. */
function lostWrite(r: StepResult): boolean {
  const ok = r.final_status !== null && r.final_status < 400;
  const textMissing = ok && r.checks.some((c) => c.name === "text" && !c.ok);
  const linkMissing = /^request failed: link ".*" not found/.test(r.error ?? "");
  const recordMissing = r.final_status === 404 && normalizePath(r.final_path) !== r.final_path; // 번호가 붙은 주소(/posts/6)만
  return textMissing || linkMissing || recordMissing;
}

export function ruleReport(diffs: StepDiff[], verdict: Verdict): Report | null {
  if (verdict.status !== "BLOCKED") return null;
  const first = diffs.find((d) => d.index === verdict.first_divergence)!;
  const failed = diffs.find((d) => d.cloud.status === "failed");
  const candOnly = failed?.local.status === "passed" ? failed : undefined;
  // 이름이 없는 StepDiff(contracts fixture)는 결과 필드 이름(local/cloud)을 그대로 쓴다.
  const base = first.baseline ?? "local";
  const cand = first.candidate ?? "cloud";

  const stepLine = (d: StepDiff) =>
    `Step ${d.index} (${d.title}) worked on ${base} (${outcome(d.local)}) but not on ${cand} (${outcome(d.cloud)}).`;
  const hopLines = (d: StepDiff) => [
    ...(d.local.status !== "passed" && d.local.hops.length ? [`${base} hops: ${hopChain(d.local.hops)}`] : []),
    ...(d.cloud.hops.length ? [`${cand} hops: ${hopChain(d.cloud.hops)}`] : []),
  ];
  const report = (headline: string, cause: string, evidence: string[], fix: Fix | null, confidence: "high" | "medium" | "low"): Report =>
    ({ headline, cause, evidence, fix, confidence, by: "rule" });

  if (failed && isUnreachable(failed.cloud)) {
    return report(
      `${cand} is not reachable`,
      `The request to ${cand} failed before any HTTP response came back (${failed.cloud.error!.slice("request failed: ".length)}). ` +
        `The app is not running, is still starting, crashed on start, or the URL/port is wrong.`,
      [stepLine(failed)],
      null,
      "high",
    );
  }

  const bounce = signInBounce(first);
  if (bounce >= 0) {
    const hops = first.cloud.hops;
    const before = hops[bounce - 1];
    return report(
      `Login is lost on ${cand}: requests land on different instances`,
      `The app keeps the login in server memory (HttpSession). ${cand} runs more than one instance behind a load balancer ` +
        `without session affinity, so the request after login reaches an instance that never saw it.`,
      [
        stepLine(first),
        ...hopLines(first),
        `${cand} sent ${hops[bounce].method} ${hops[bounce].path} back to the sign-in page (${hops[bounce + 1].path})` +
          `${before ? ` right after ${before.method} ${before.path}` : ""}; ${base} did not.`,
      ],
      {
        target: cand,
        option: "sticky_sessions",
        value: "true",
        description: "Pin each user to one instance (session affinity).",
        native: "nginx upstream ip_hash (on AWS: ALB target-group stickiness, or App Runner auto scaling max size 1 since it has no stickiness; on Cloud Run: --session-affinity)",
        // 아직 어느 대상도 이 옵션을 실제로 적용하지 못한다(infra/local은 받기만 함, aws는 미확인).
        // true로 두면 엔진이 자동 수정을 시도하고 "자동 수정 후에도 차단"이 뜬다.
        auto_applicable: false,
      },
      "high",
    );
  }

  if (candOnly && !isSignIn(candOnly.cloud.final_path) && lostWrite(candOnly.cloud)) {
    return report(
      `Data is lost on ${cand}: what was just written does not come back`,
      `${cand} accepted the write but did not show it afterwards, while ${base} did. Writes are not persisted or not shared on ${cand}: ` +
        `it may use an in-memory/embedded DB, a separate DB per instance, or a DB that is reset on restart.`,
      [stepLine(candOnly), ...hopLines(candOnly)],
      {
        target: cand,
        option: "code_change",
        value: "use the shared database (RDS) via SPRING_DATASOURCE_URL",
        description: "Point every instance at one persistent database instead of an embedded one.",
        native: "App Runner env var SPRING_DATASOURCE_URL → RDS endpoint",
        auto_applicable: false,
      },
      "medium",
    );
  }

  const status = candOnly?.cloud.final_status ?? 0;
  if (candOnly && status >= 500) {
    return report(
      `${cand} fails with a server error (HTTP ${status})`,
      `${cand} answered step ${candOnly.index} (${candOnly.title}) with HTTP ${status} where ${base} worked. ` +
        `A server error that only shows up after deploying is most often the database connection or config, ` +
        `e.g. a DB URL hard-coded to localhost that does not exist on ${cand}.`,
      [stepLine(candOnly), ...hopLines(candOnly)],
      {
        target: cand,
        option: "code_change",
        value: "move the DB URL to environment variables",
        description: "Read the DB URL, user and password from environment variables instead of hard-coding them.",
        native: "application.yml spring.datasource.url: ${SPRING_DATASOURCE_URL} (App Runner env var → RDS endpoint)",
        auto_applicable: false,
      },
      "medium",
    );
  }

  return report(
    `Step ${first.index} (${first.title}) differs between ${base} and ${cand}`,
    `The first difference is at step ${first.index} (${first.title}): ${first.reasons.join("; ")}. ` +
      `It does not match a known cause (unreachable, lost login, lost data, server error), so read the hops below.`,
    [`Step ${first.index} (${first.title}): ${base} ${outcome(first.local)}; ${cand} ${outcome(first.cloud)}.`, ...hopLines(first)],
    null,
    "low",
  );
}
