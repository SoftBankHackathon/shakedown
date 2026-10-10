// 판정이 BLOCKED일 때 단계 비교 결과만 보고 원인 보고서를 만든다. AI는 쓰지 않는다.
// 데모 버그가 아직 정해지지 않아서 알려진 원인 넷을 정해진 순서로 확인하고, 아무것도 맞지 않으면 일반 보고서를 낸다.
// hop.instance는 응답 헤더(X-Instance-Id)로 기록된다. 원인 추정은 hop 경로를 기준으로 하고,
// 로그인 풀림만 로그인을 받은 서버와 튕긴 요청을 받은 서버의 ID가 둘 다 있고 서로 다르면 근거 한 줄을 덧붙인다.
import type { Fix, Hop, Report, ReportLang, StepDiff, StepResult } from "@shakedown/contracts";
import { normalizePath } from "./compare.ts";
import type { Verdict } from "./verdict.ts";

/**
 * 로그인 화면. kty-board는 "/"가 로그인 화면이다. 게시판이 아닌 앱은 마지막 칸이 login·signin·sign_in으로 끝나는 주소(/signin, /auth/login, /users/sign_in, /perform_login)를 쓴다.
 * 로그인 칸은 마지막 칸이어야 한다(/auth/register는 아님). kty-board처럼 /login으로 시작하는 주소는 지금처럼 받는다.
 */
function isSignIn(path: string | null): boolean {
  if (path === null) return false;
  const p = path.split("?")[0];
  return p === "/" || p.startsWith("/login") || /\/([a-z]*[_-])?(log|sign)[-_]?in\/?$/i.test(p);
}

/** 로그인을 받는 POST. 로그인 화면 주소에 더해, 로그인 폼이 흔히 보내는 /auth·/session(s)·Spring Security 기본값도 마지막 칸이면 로그인으로 본다. */
function isSignInPost(h: Hop): boolean {
  return h.method === "POST" && (isSignIn(h.path) || /\/(auth|sessions?|j_spring_security_check)\/?$/i.test(h.path.split("?")[0]));
}

function hopChain(hops: Hop[]): string {
  return hops.map((h) => `${h.method} ${h.path} ${h.status}`).join(" → ");
}

/** 한 환경에서 그 단계가 어떻게 끝났는지. 예: "ended on /board, 'x' not shown" */
function outcome(r: StepResult): string {
  if (r.final_path === null || r.error?.startsWith("ended on")) return r.error ?? r.status;
  return r.error ? `ended on ${r.final_path}, ${r.error}` : `ended on ${r.final_path}`;
}

// steps.ts는 폼·링크를 못 찾거나, 삭제·로그아웃이라 보내지 않았거나, 리다이렉트가 너무 많을 때도 "request failed:"를 붙인다. 이건 접속 실패가 아니다.
function isUnreachable(r: StepResult): boolean {
  return (
    r.final_status === null &&
    r.error !== null &&
    r.error.startsWith("request failed:") &&
    !/not found on the current page|looks unsafe|too many redirects/.test(r.error)
  );
}

/**
 * 기준 환경은 로그인이 필요한 화면에 머물렀는데 비교 환경만 로그인 화면으로 되돌려졌다면,
 * 되돌린 hop(로그인 직후의 POST, 또는 보호된 화면 GET)의 위치를 돌려준다. 없으면 -1.
 * 게시판이 아닌 앱은 "/"가 로그인 화면이 아닐 수 있어서, 로그인한 적 없이 "/"로 돌아간 것(GET만 하는 둘러보기 등)은
 * 로그인 풀림이 아니다. 그래서 튕긴 hop과 그 앞(앞 단계 포함)에 로그인 POST가 있을 때만 로그인 풀림으로 본다.
 */
function signInBounce(diffs: StepDiff[], d: StepDiff): number {
  if (d.local.status !== "passed" || isSignIn(d.local.final_path) || !isSignIn(d.cloud.final_path)) return -1;
  const hops = d.cloud.hops;
  const bounce = hops.findIndex((from, i) => {
    const to = hops[i + 1];
    return (
      to !== undefined && to.method === "GET" && isSignIn(to.path) &&
      from.status >= 300 && from.status < 400 &&
      (from.method === "POST" || !isSignIn(from.path))
    );
  });
  // 튕긴 hop 자체가 로그인 POST인 경우(로그인 응답이 바로 로그인 화면으로 보냄)도 넣으려고 bounce + 1까지 본다.
  return bounce >= 0 && loginHop(diffs, d, bounce + 1) ? bounce : -1;
}

/**
 * 로그인을 받은 hop: 그 단계의 비교 환경 hop 중 앞에서 end개(앞 단계 hop은 모두) 안의 마지막 POST 로그인.
 * Cloud Run처럼 요청이 가끔만 다른 서버로 가면 로그인 단계는 통과하고 뒤 단계에서 튕긴다. 그래서 앞 단계까지 거슬러 찾는다.
 */
function loginHop(diffs: StepDiff[], first: StepDiff, end: number): Hop | undefined {
  const earlier = diffs.filter((d) => d.index < first.index).flatMap((d) => d.cloud.hops);
  return [...earlier, ...first.cloud.hops.slice(0, end)].findLast(isSignInPost);
}

/** 보고서 언어. 요청의 lang(없으면 en). 목록은 contracts의 ReportLang 하나로 둔다. */
export type Lang = ReportLang;

// 규칙 보고서 문장(언어별). 경로·hop 사슬·단계 제목·검사 오류 글자(ended on …)·환경 이름 같은 데이터 조각은 그대로 끼워 넣는다.
// 판정 요약(verdict.summary)과 단계 비교 이유(reasons)는 규칙 데이터라 영어 그대로 두고, 아래 문장에도 영어 그대로 들어간다.
// 한국어는 환경 이름 뒤에 받침에 따라 바뀌는 조사(은/는, 이/가)를 붙이지 않는다("aws에서", "local에서는"처럼 늘 같은 조사만).
const en = {
  step: (i: number, title: string, base: string, bo: string, cand: string, co: string) =>
    `Step ${i} (${title}) worked on ${base} (${bo}) but not on ${cand} (${co}).`,
  hops: (env: string, chain: string) => `${env} hops: ${chain}`,
  unreachable: (cand: string) => `${cand} is not reachable`,
  unreachableCause: (cand: string, error: string) =>
    `The request to ${cand} failed before any HTTP response came back (${error}). ` +
    `The app is not running, is still starting, crashed on start, or the URL/port is wrong.`,
  loginLost: (cand: string) => `Login is lost on ${cand}: requests land on different instances`,
  loginLostCause: (cand: string) =>
    `The app keeps the login in server memory (HttpSession). ${cand} runs more than one instance behind a load balancer ` +
    `without session affinity, so the request after login reaches an instance that never saw it.`,
  bounced: (cand: string, hop: string, to: string, before: string | null, base: string) =>
    `${cand} sent ${hop} back to the sign-in page (${to})${before ? ` right after ${before}` : ""}; ${base} did not.`,
  switched: (login: string, loginId: string, bounced: string, bouncedId: string) =>
    `${login} was handled by instance ${loginId}, ${bounced} by instance ${bouncedId}: 2 different instances served one user's requests.`,
  loginLostFix: "Keep the login in the shared database (Spring Session JDBC) so every instance sees it.",
  dataLost: (cand: string) => `Data is lost on ${cand}: what was just written does not come back`,
  dataLostCause: (cand: string, base: string) =>
    `${cand} accepted the write but did not show it afterwards, while ${base} did. Writes are not persisted or not shared on ${cand}: ` +
    `it may use an in-memory/embedded DB, a separate DB per instance, or a DB that is reset on restart.`,
  dataLostFix: "Point every instance at one persistent database instead of an embedded one.",
  serverError: (cand: string, status: number) => `${cand} fails with a server error (HTTP ${status})`,
  serverErrorCause: (cand: string, base: string, i: number, title: string, status: number) =>
    `${cand} answered step ${i} (${title}) with HTTP ${status} where ${base} worked. ` +
    `A server error that only shows up after deploying is most often the database connection or config, ` +
    `e.g. a DB URL hard-coded to localhost that does not exist on ${cand}.`,
  serverErrorFix: "Read the DB URL, user and password from environment variables instead of hard-coding them.",
  other: (i: number, title: string, base: string, cand: string) => `Step ${i} (${title}) differs between ${base} and ${cand}`,
  otherCause: (i: number, title: string, reasons: string) =>
    `The first difference is at step ${i} (${title}): ${reasons}. ` +
    `It does not match a known cause (unreachable, lost login, lost data, server error), so read the hops below.`,
  otherStep: (i: number, title: string, base: string, bo: string, cand: string, co: string) =>
    `Step ${i} (${title}): ${base} ${bo}; ${cand} ${co}.`,
};

const WORDS: Record<Lang, typeof en> = {
  en,
  ko: {
    step: (i, title, base, bo, cand, co) => `${i}단계(${title}): ${base}에서는 됨(${bo}), ${cand}에서는 안 됨(${co}).`,
    hops: (env, chain) => `${env} 요청 경로: ${chain}`,
    unreachable: (cand) => `${cand}에 접속할 수 없습니다`,
    unreachableCause: (cand, error) =>
      `${cand}에 보낸 요청이 HTTP 응답을 받기 전에 실패했습니다(${error}). ` +
      `앱이 꺼져 있거나, 아직 켜지는 중이거나, 켜지다가 죽었거나, 주소·포트가 틀렸습니다.`,
    loginLost: (cand) => `${cand}에서 로그인이 풀립니다: 요청이 서로 다른 인스턴스로 갑니다`,
    loginLostCause: (cand) =>
      `앱이 로그인 상태를 서버 메모리(HttpSession)에 둡니다. ${cand}에서는 로드 밸런서 뒤에 인스턴스가 여러 대인데 ` +
      `세션 고정(session affinity)이 없어서, 로그인 다음 요청이 로그인을 모르는 인스턴스로 갑니다.`,
    bounced: (cand, hop, to, before, base) =>
      `${cand}에서는 ${before ? `${before} 바로 뒤 ` : ""}${hop} 요청이 로그인 화면(${to})으로 되돌아갔습니다. ${base}에서는 그러지 않았습니다.`,
    switched: (login, loginId, bounced, bouncedId) =>
      `${login} 요청은 인스턴스 ${loginId}, ${bounced} 요청은 인스턴스 ${bouncedId}에서 처리했습니다. 한 사용자의 요청을 서로 다른 인스턴스 2대가 받았습니다.`,
    loginLostFix: "로그인 상태를 공유 DB(Spring Session JDBC)에 두어 모든 인스턴스가 보게 합니다.",
    dataLost: (cand) => `${cand}에서 데이터가 사라집니다: 방금 쓴 내용이 다시 보이지 않습니다`,
    dataLostCause: (cand, base) =>
      `${cand}에서는 쓰기를 받고도 그 내용을 다시 보여 주지 않았습니다(${base}에서는 보임). 쓴 내용이 저장되지 않거나 인스턴스끼리 공유되지 않습니다. ` +
      `메모리·내장 DB를 쓰거나, 인스턴스마다 DB가 따로이거나, 다시 켤 때 DB가 초기화될 수 있습니다.`,
    dataLostFix: "내장 DB 대신 모든 인스턴스가 하나의 영구 DB를 쓰게 합니다.",
    serverError: (cand, status) => `${cand}에서 서버 오류가 납니다(HTTP ${status})`,
    serverErrorCause: (cand, base, i, title, status) =>
      `${i}단계(${title})가 ${base}에서는 됐지만 ${cand}에서는 HTTP ${status}로 끝났습니다. ` +
      `배포한 뒤에만 나는 서버 오류는 대개 DB 연결이나 설정 문제입니다. 예를 들어 DB 주소를 localhost로 박아 두면 ${cand}에는 그 DB가 없습니다.`,
    serverErrorFix: "DB 주소·사용자·비밀번호를 코드에 박지 말고 환경변수에서 읽게 합니다.",
    other: (i, title, base, cand) => `${i}단계(${title})의 결과가 ${base}·${cand}에서 다릅니다`,
    otherCause: (i, title, reasons) =>
      `처음 달라진 곳은 ${i}단계(${title})입니다: ${reasons}. ` +
      `알려진 원인(접속 불가, 로그인 풀림, 데이터 유실, 서버 오류)에 맞지 않으니 아래 요청 경로를 보세요.`,
    otherStep: (i, title, base, bo, cand, co) => `${i}단계(${title}): ${base} ${bo}; ${cand} ${co}.`,
  },
  ja: {
    step: (i, title, base, bo, cand, co) => `ステップ ${i}（${title}）は ${base} では通りましたが（${bo}）、${cand} では通りませんでした（${co}）。`,
    hops: (env, chain) => `${env} のリクエスト経路: ${chain}`,
    unreachable: (cand) => `${cand} に接続できません`,
    unreachableCause: (cand, error) =>
      `${cand} へのリクエストが HTTP 応答を受け取る前に失敗しました（${error}）。` +
      `アプリが起動していない、起動中、起動直後に落ちた、または URL・ポートが間違っています。`,
    loginLost: (cand) => `${cand} でログインが切れます: リクエストが別々のインスタンスに届いています`,
    loginLostCause: (cand) =>
      `アプリはログイン状態をサーバーのメモリ（HttpSession）に保持しています。${cand} ではロードバランサーの後ろに複数のインスタンスがあり、` +
      `セッションアフィニティがないため、ログイン後のリクエストがログインを知らないインスタンスに届きます。`,
    bounced: (cand, hop, to, before, base) =>
      `${cand} では${before ? ` ${before} の直後に` : ""} ${hop} がログイン画面（${to}）に戻されました。${base} ではそうなりませんでした。`,
    switched: (login, loginId, bounced, bouncedId) =>
      `${login} はインスタンス ${loginId}、${bounced} はインスタンス ${bouncedId} で処理されました。同じユーザーのリクエストを別々のインスタンス2台が受けています。`,
    loginLostFix: "ログイン状態を共有データベース（Spring Session JDBC）に保存し、すべてのインスタンスから見えるようにします。",
    dataLost: (cand) => `${cand} でデータが失われます: 書き込んだ内容が表示されません`,
    dataLostCause: (cand, base) =>
      `${cand} は書き込みを受け付けましたが、その後表示しませんでした（${base} では表示されました）。書き込みが保存されていないか、インスタンス間で共有されていません。` +
      `メモリ・組み込み DB、インスタンスごとに別の DB、再起動のたびに初期化される DB などが考えられます。`,
    dataLostFix: "組み込み DB ではなく、すべてのインスタンスが同じ永続データベースを使うようにします。",
    serverError: (cand, status) => `${cand} でサーバーエラーが発生します（HTTP ${status}）`,
    serverErrorCause: (cand, base, i, title, status) =>
      `ステップ ${i}（${title}）は ${base} では通りましたが、${cand} では HTTP ${status} になりました。` +
      `デプロイ後にだけ出るサーバーエラーは、多くの場合データベースの接続や設定が原因です。たとえば DB の URL を localhost に固定していると、${cand} にはその DB がありません。`,
    serverErrorFix: "DB の URL・ユーザー・パスワードをコードに書かず、環境変数から読むようにします。",
    other: (i, title, base, cand) => `ステップ ${i}（${title}）の結果が ${base} と ${cand} で異なります`,
    otherCause: (i, title, reasons) =>
      `最初の違いはステップ ${i}（${title}）です: ${reasons}。` +
      `既知の原因（接続不可、ログイン切れ、データ消失、サーバーエラー）に当てはまらないため、下のリクエスト経路を確認してください。`,
    otherStep: (i, title, base, bo, cand, co) => `ステップ ${i}（${title}）: ${base} ${bo}、${cand} ${co}。`,
  },
};

/** 받을 수 있는 lang 값. 문장을 가진 언어(WORDS의 키)에서 만들어 둘이 어긋나지 않게 한다. */
export const LANGS = Object.keys(WORDS) as Lang[];

/**
 * 어느 서버가 답했는지 근거 한 줄. 경로만으로는 "다른 서버로 갔다"가 추정이지만, 두 ID가 다르면 직접 보여 준다.
 * ID가 하나라도 없거나(헤더를 안 내는 앱) 같으면 아무것도 보태지 않는다. 그때는 지금처럼 경로 근거만 남는다.
 */
function instanceLine(words: typeof en, login: Hop | undefined, bounced: Hop): string | null {
  if (!login?.instance || !bounced.instance || login.instance === bounced.instance) return null;
  return words.switched(`${login.method} ${login.path}`, login.instance, `${bounced.method} ${bounced.path}`, bounced.instance);
}

// instanceLine이 만드는 줄의 모양(세 언어). 만드는 문장(WORDS.switched)에서 바로 만들어, 문장을 바꾸면 알아보는 쪽도 함께 바뀐다.
// 서버 ID는 앱이 정하는 아무 문자열이라("web 1", 헤더가 두 번 와서 ", "로 이어진 값) 자리마다 아무 글자나 받는다.
const SLOT = "\u0000";
const SWITCHED = LANGS.map((lang) => {
  const escaped = WORDS[lang].switched(SLOT, SLOT, SLOT, SLOT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll(SLOT, ".+")}$`, "s");
});

/** 규칙 보고서 evidence에 있는 서버 전환 근거 줄(어느 언어든). ai-report가 AI 답에 이 줄을 지킬 때 쓴다. */
export function switchLine(evidence: string[]): string | undefined {
  return evidence.find((line) => SWITCHED.some((re) => re.test(line)));
}

/** 방금 쓴 값(글 제목·본문·댓글)이 비교 환경에서만 다시 보이지 않는다. */
function lostWrite(r: StepResult): boolean {
  const ok = r.final_status !== null && r.final_status < 400;
  const textMissing = ok && r.checks.some((c) => c.name === "text" && !c.ok);
  const linkMissing = /^request failed: link ".*" not found/.test(r.error ?? "");
  const recordMissing = r.final_status === 404 && normalizePath(r.final_path) !== r.final_path; // 번호가 붙은 주소(/posts/6)만
  return textMissing || linkMissing || recordMissing;
}

export function ruleReport(
  diffs: StepDiff[],
  verdict: Verdict,
  { canApplyEnv = false, lang = "en" }: { canApplyEnv?: boolean; lang?: Lang } = {},
): Report | null {
  if (verdict.status !== "BLOCKED") return null;
  const w = WORDS[lang];
  const first = diffs.find((d) => d.index === verdict.first_divergence)!;
  const failed = diffs.find((d) => d.cloud.status === "failed");
  const candOnly = failed?.local.status === "passed" ? failed : undefined;
  // 이름이 없는 StepDiff(contracts fixture)는 결과 필드 이름(local/cloud)을 그대로 쓴다.
  const base = first.baseline ?? "local";
  const cand = first.candidate ?? "cloud";

  const stepLine = (d: StepDiff) => w.step(d.index, d.title, base, outcome(d.local), cand, outcome(d.cloud));
  const hopLines = (d: StepDiff) => [
    ...(d.local.status !== "passed" && d.local.hops.length ? [w.hops(base, hopChain(d.local.hops))] : []),
    ...(d.cloud.hops.length ? [w.hops(cand, hopChain(d.cloud.hops))] : []),
  ];
  const report = (headline: string, cause: string, evidence: string[], fix: Fix | null, confidence: "high" | "medium" | "low"): Report =>
    ({ headline, cause, evidence, fix, confidence, by: "rule" });

  if (failed && isUnreachable(failed.cloud)) {
    return report(
      w.unreachable(cand),
      w.unreachableCause(cand, failed.cloud.error!.slice("request failed: ".length)),
      [stepLine(failed)],
      null,
      "high",
    );
  }

  const bounce = signInBounce(diffs, first);
  if (bounce >= 0) {
    const hops = first.cloud.hops;
    const before = hops[bounce - 1];
    const switched = instanceLine(w, loginHop(diffs, first, bounce), hops[bounce]);
    return report(
      w.loginLost(cand),
      w.loginLostCause(cand),
      [
        stepLine(first),
        ...hopLines(first),
        w.bounced(cand, `${hops[bounce].method} ${hops[bounce].path}`, hops[bounce + 1].path, before ? `${before.method} ${before.path}` : null, base),
        ...(switched ? [switched] : []),
      ],
      {
        target: cand,
        // 세션을 서버 메모리 대신 공유 DB(Spring Session JDBC)에 두면 몇 대로 늘려도 로그인이 유지된다.
        // 같은 이미지에 프로필 env만 바꾸면 되고, 세 어댑터(local·aws·gcp)가 이 값을 이미 받는다.
        option: "env",
        value: "SPRING_PROFILES_ACTIVE=demo,session-jdbc",
        description: w.loginLostFix,
        native: "Cloud Run / ECS env SPRING_PROFILES_ACTIVE=demo,session-jdbc (sessions in the spring_session table of Cloud SQL / RDS)",
        // env를 바꿔 다시 배포할 수 있는 대상인지는 엔진만 안다(hints.can_apply_env). 모르면 제안만 한다.
        auto_applicable: canApplyEnv,
      },
      "high",
    );
  }

  // 비교 환경만 로그인 화면에서 끝났으면 쓴 글이 안 보이는 게 아니라 로그인이 풀린 것이다. 기준 환경도 같은 화면에서 끝났다면
  // 그 화면은 이 앱의 보통 화면이다("/"가 로그인 화면이 아닌 앱이 쓰기 뒤 "/"에서 확인하는 경우).
  const bouncedToSignIn = candOnly !== undefined && isSignIn(candOnly.cloud.final_path) && !isSignIn(candOnly.local.final_path);
  if (candOnly && !bouncedToSignIn && lostWrite(candOnly.cloud)) {
    return report(
      w.dataLost(cand),
      w.dataLostCause(cand, base),
      [stepLine(candOnly), ...hopLines(candOnly)],
      {
        target: cand,
        option: "code_change",
        // 앱 스택(Spring·Node·Python)과 클라우드마다 이름이 달라서, 공통 방법을 쓰고 흔한 env 이름은 예로만 든다.
        value: "point every instance at one shared managed database via an env var (e.g. DATABASE_URL, SPRING_DATASOURCE_URL)",
        description: w.dataLostFix,
        native: "Cloud Run / ECS / Container Apps env var (e.g. DATABASE_URL, SPRING_DATASOURCE_URL) → shared managed DB (Cloud SQL / RDS / Azure Database)",
        auto_applicable: false,
      },
      "medium",
    );
  }

  const status = candOnly?.cloud.final_status ?? 0;
  if (candOnly && status >= 500) {
    return report(
      w.serverError(cand, status),
      w.serverErrorCause(cand, base, candOnly.index, candOnly.title, status),
      [stepLine(candOnly), ...hopLines(candOnly)],
      {
        target: cand,
        option: "code_change",
        value: "move the DB URL to environment variables",
        description: w.serverErrorFix,
        native:
          "read the DB URL from an env var (e.g. DATABASE_URL; in Spring spring.datasource.url: ${SPRING_DATASOURCE_URL}) " +
          "set on Cloud Run / ECS / Container Apps to the managed DB (Cloud SQL / RDS / Azure Database)",
        auto_applicable: false,
      },
      "medium",
    );
  }

  return report(
    w.other(first.index, first.title, base, cand),
    w.otherCause(first.index, first.title, first.reasons.join("; ")),
    [w.otherStep(first.index, first.title, base, outcome(first.local), cand, outcome(first.cloud)), ...hopLines(first)],
    null,
    "low",
  );
}
