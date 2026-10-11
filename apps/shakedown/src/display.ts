// 사람이 읽는 글(판정 요약·단계 비교 이유·원인 보고서)에 끼워 넣는 조각: 환경 표시 이름과 검사 결과 글의 번역.
// 기계 필드(StepDiff.baseline·candidate, StepResult.error·checks, fix.target)는 그대로 둔다. 규칙(판정·원인 추정)은 그 기계 값만 본다.
import type { ReportLang, StepResult } from "@shakedown/contracts";

/** 환경 ID → 표시 이름. AI 프롬프트에도 이 목록을 그대로 알려 준다. */
export const DISPLAY_NAMES: Record<string, string> = {
  local: "Local",
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
  onprem: "On-prem",
  candidate: "Candidate",
};

/** 표시 이름. 목록에 없는 이름(fixture의 cloud, 사람이 정한 이름)은 그대로 둔다. */
export function displayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id;
}

const STATUS: Record<ReportLang, Record<StepResult["status"], string>> = {
  en: { passed: "passed", failed: "failed", skipped: "skipped" },
  ko: { passed: "통과", failed: "실패", skipped: "건너뜀" },
  ja: { passed: "成功", failed: "失敗", skipped: "スキップ" },
};

/** 단계 상태(passed·failed·skipped)를 그 언어 낱말로. */
export function statusWord(status: StepResult["status"], lang: ReportLang): string {
  return STATUS[lang][status];
}

// steps.ts·checks.ts가 만드는 글(영어)의 모양과 언어별 바꿀 글. 모르는 글은 그대로 둔다(영어는 바꾸지 않는다).
// 따옴표 안 값(쓴 글 제목, 링크 글자)과 경로는 화면 데이터라 번역하지 않는다.
const DETAILS: Array<[RegExp, Record<Exclude<ReportLang, "en">, string>]> = [
  [/^'(.*)' not shown$/s, { ko: "'$1' 안 보임", ja: "'$1' が表示されない" }],
  [/^'(.*)' shown$/s, { ko: "'$1' 보임", ja: "'$1' が表示された" }],
  [/^ended on (\S+), expected (\S+)$/, { ko: "$1에서 끝남(기대: $2)", ja: "$1 で終了（期待: $2）" }],
  [/^ended on (\S+)$/, { ko: "$1에서 끝남", ja: "$1 で終了" }],
  [/^an earlier step failed$/, { ko: "앞 단계가 실패함", ja: "前のステップが失敗" }],
  [/^request failed: form (\S+) not found on the current page$/, { ko: "요청 실패: 현재 화면에 폼 $1 없음", ja: "リクエスト失敗: 現在の画面にフォーム $1 がない" }],
  [/^request failed: link (".*") not found on the current page$/s, { ko: "요청 실패: 현재 화면에 링크 $1 없음", ja: "リクエスト失敗: 現在の画面にリンク $1 がない" }],
  [/^request failed: (.*)$/s, { ko: "요청 실패: $1", ja: "リクエスト失敗: $1" }],
];

/** 검사 결과·단계 오류 글 하나를 그 언어로. en이면 그대로. */
export function detailText(text: string, lang: ReportLang): string {
  if (lang === "en") return text;
  for (const [re, to] of DETAILS) if (re.test(text)) return text.replace(re, to[lang]);
  return text;
}
