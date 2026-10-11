// 단계 비교 결과로 최종 판정을 내린다. AI는 관여하지 않는다.
import type { Attempt, ReportLang, StepDiff } from "@shakedown/contracts";
import { displayName } from "./display.ts";

export type Verdict = NonNullable<Attempt["verdict"]>;

// 요약 글(언어별). 환경 이름은 표시 이름(Local·GCP)으로 넣는다. 판정 자체는 아래 judge가 severity로만 정한다.
const SUMMARY: Record<ReportLang, {
  head: (i: number, title: string) => string;
  pathDiff: (head: string, bp: string | null, bn: string, cp: string | null, cn: string) => string;
  bothFailed: (head: string) => string;
  other: (head: string, reasons: string) => string;
  same: string;
}> = {
  en: {
    head: (i, title) => `Step ${i} (${title})`,
    pathDiff: (head, bp, bn, cp, cn) => `${head} led to different pages (${bp} on ${bn}, ${cp} on ${cn}).`,
    bothFailed: (head) => `${head} failed on both environments.`,
    other: (head, reasons) => `${head}: ${reasons}.`,
    same: "Both environments behaved the same on every step.",
  },
  ko: {
    head: (i, title) => `${i}단계(${title})`,
    pathDiff: (head, bp, bn, cp, cn) => `${head}에서 도착한 화면이 다릅니다(${bn}: ${bp}, ${cn}: ${cp}).`,
    bothFailed: (head) => `${head}: 두 환경 모두에서 실패했습니다.`,
    other: (head, reasons) => `${head}: ${reasons}.`,
    same: "모든 단계에서 두 환경이 똑같이 동작했습니다.",
  },
  ja: {
    head: (i, title) => `ステップ ${i}（${title}）`,
    pathDiff: (head, bp, bn, cp, cn) => `${head}で到達した画面が異なります（${bn}: ${bp}、${cn}: ${cp}）。`,
    bothFailed: (head) => `${head}は両方の環境で失敗しました。`,
    other: (head, reasons) => `${head}: ${reasons}。`,
    same: "すべてのステップで両環境の動作が一致しました。",
  },
};

function describe(d: StepDiff, lang: ReportLang): string {
  const w = SUMMARY[lang];
  const head = w.head(d.index, d.title);
  if (d.kind === "path_diff") {
    // 이름이 없는 StepDiff(contracts fixture)는 결과 필드 이름(local/cloud)을 쓴다.
    return w.pathDiff(head, d.local.final_path, displayName(d.baseline ?? "local"), d.cloud.final_path, displayName(d.candidate ?? "cloud"));
  }
  if (d.kind === "both_failed") return w.bothFailed(head);
  return w.other(head, d.reasons.join("; "));
}

/** lang: 요약 글(summary)의 언어. 없으면 영어. status와 first_divergence는 언어와 상관없다. */
export function judge(diffs: StepDiff[], lang: ReportLang = "en"): Verdict {
  const critical = diffs.find((d) => d.severity === "critical");
  const warn = diffs.find((d) => d.severity === "warn");
  const first = diffs.find((d) => d.severity === "critical" || d.severity === "warn");

  if (critical) return { status: "BLOCKED", first_divergence: first!.index, summary: describe(critical, lang) };
  if (warn) return { status: "WARN", first_divergence: first!.index, summary: describe(warn, lang) };
  return { status: "PASS", first_divergence: null, summary: SUMMARY[lang].same };
}
