// 기준 환경(baseline)과 비교 환경(candidate)의 단계 결과를 맞대서 StepDiff를 만든다.
// 규칙과 문구는 contracts fixture(deployment-blocked-then-fixed.json)에 맞춘다.
import type { ReportLang, StepDiff, StepResult } from "@shakedown/contracts";
import { detailText, displayName, statusWord } from "./display.ts";

export type Names = { baseline: string; candidate: string };

/**
 * 글 번호처럼 환경마다 다른 경로 조각은 같은 것으로 본다. /posts/11 ≡ /posts/6
 * 숫자뿐 아니라 MongoDB ObjectId(24자 hex)와 UUID도 DB가 만드는 번호라서 같이 본다(게시판이 아닌 앱).
 */
export function normalizePath(path: string | null): string | null {
  return path === null ? null : path.replace(/\/(\d+|[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|\?|$)/gi, "/{n}");
}

// 이유 글(언어별). 환경 이름은 표시 이름(Local·GCP)으로 넣는다. 영어 문구는 fixture와 같다(환경 이름만 표시 이름).
// 판정(verdict.ts)과 원인 추정(report.ts)은 kind·severity와 StepResult만 보고, 이 글은 읽지 않는다.
const REASONS: Record<ReportLang, { ended: (b: string, bn: string, c: string, cn: string) => string; pair: (a: string, as: string, b: string, bs: string) => string }> = {
  en: { ended: (b, bn, c, cn) => `ended on ${b} (${bn}) vs ${c} (${cn})`, pair: (a, as, b, bs) => `${as} on ${a}, ${bs} on ${b}` },
  ko: { ended: (b, bn, c, cn) => `끝난 곳: ${b}(${bn}) / ${c}(${cn})`, pair: (a, as, b, bs) => `${a}에서는 ${as}, ${b}에서는 ${bs}` },
  ja: { ended: (b, bn, c, cn) => `終了ページ: ${b}（${bn}）/ ${c}（${cn}）`, pair: (a, as, b, bs) => `${a} では${as}、${b} では${bs}` },
};

function classify(b: StepResult, c: StepResult, n: Names, lang: ReportLang): Pick<StepDiff, "kind" | "severity" | "reasons"> {
  const w = REASONS[lang];
  const [bn, cn] = [displayName(n.baseline), displayName(n.candidate)];
  const pair = (x: StepResult, xn: string, y: StepResult, yn: string) => w.pair(xn, statusWord(x.status, lang), yn, statusWord(y.status, lang));
  const ended = w.ended(b.final_path ?? "None", bn, c.final_path ?? "None", cn);

  if (b.status === "passed" && c.status === "passed") {
    return normalizePath(b.final_path) === normalizePath(c.final_path)
      ? { kind: "same", severity: "none", reasons: [] }
      : { kind: "path_diff", severity: "critical", reasons: [ended] };
  }
  if (b.status === "skipped" && c.status === "skipped") {
    return { kind: "skipped", severity: "ignore", reasons: [] };
  }
  if (b.status !== "passed" && c.status !== "passed") {
    return { kind: "both_failed", severity: "critical", reasons: [pair(b, bn, c, cn)] };
  }
  const [ok, bad, okName, badName] = b.status === "passed" ? [b, c, bn, cn] : [c, b, cn, bn];
  return {
    kind: "env_diff",
    severity: "critical",
    reasons: [pair(ok, okName, bad, badName), ...(bad.error ? [detailText(bad.error, lang)] : []), ended],
  };
}

/** lang: 이유 글(reasons)의 언어. 없으면 영어. */
export function compareSteps(baseline: StepResult[], candidate: StepResult[], names: Names, lang: ReportLang = "en"): StepDiff[] {
  return baseline.map((b, i) => {
    const c = candidate[i];
    return {
      index: b.index,
      baseline: names.baseline,
      candidate: names.candidate,
      title: b.title,
      local: b,
      cloud: c,
      ...classify(b, c, names, lang),
      classified_by: "rule",
    };
  });
}
