// BLOCKED 판정의 원인 보고서를 Claude에게 받는다.
// AI는 선택 기능이다. 꺼져 있거나 실패하면 규칙 보고서(fallback)를 그대로 돌려준다.
import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger, Fix, Report, StepDiff, StepResult } from "@shakedown/contracts";
import { switchLine, type Lang } from "./report.ts";
import type { Verdict } from "./verdict.ts";

// 가격 출처: claude-api 스킬 shared/models.md 모델 표(2026-09-25 캐시). claude-opus-5-5는 100만 토큰당 입력 $4, 출력 $20
export const MODEL = "claude-opus-5-5";
const USD_PER_MTOK_IN = 4;
const USD_PER_MTOK_OUT = 20;
const USD_TO_KRW = 1400;
const TIMEOUT_MS = 20_000;
// 재시도하면 최악의 경우 시간이 두 배가 되어 시운전 마감(150초)을 위협한다. 한 번만 시도하고 실패하면 규칙 보고서로 간다.
const MAX_RETRIES = 0;
// Opus 5.5는 생각(thinking)을 끌 수 없고 그 토큰도 max_tokens에 들어가서, 보고서 길이보다 넉넉히 잡는다.
const MAX_TOKENS = 4000;
// fallbacks: "default"(거절 종류별로 서버가 대체 모델을 고름)는 이 날짜의 헤더와 짝이다. 배열 형식은 날짜가 달라 400이 난다.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const CONFIDENCE = ["high", "medium", "low"];
const FIX_TEXT_FIELDS = ["target", "option", "value", "description", "native"] as const;

const text = { type: "string" };
const REPORT_SCHEMA = {
  type: "object",
  properties: {
    headline: text,
    cause: text,
    evidence: { type: "array", items: text },
    fix: {
      anyOf: [
        {
          type: "object",
          properties: { ...Object.fromEntries(FIX_TEXT_FIELDS.map((k) => [k, text])), auto_applicable: { type: "boolean" } },
          required: [...FIX_TEXT_FIELDS, "auto_applicable"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    confidence: { type: "string", enum: CONFIDENCE },
  },
  required: ["headline", "cause", "evidence", "fix", "confidence"],
  additionalProperties: false,
};

/** 보고서·시나리오를 쓸 언어의 영어 이름. 지시문은 영어로 두고 답만 이 언어로 받는다. */
export const LANG_NAME: Record<Lang, string> = { ko: "Korean", en: "English", ja: "Japanese" };

const system = (lang: Lang) => [
  "You explain why a web app behaves differently on a candidate deploy environment than on the baseline environment during an automated shakedown run.",
  "Use only the data in the user message. If the data does not show something, do not claim it; lower the confidence instead.",
  "rule_report is a rule-based guess that you may confirm or correct.",
  `Answer in ${LANG_NAME[lang]} with: headline (one sentence), cause (two or three sentences), evidence (short facts taken from the data),`,
  "fix (one setting change on the candidate environment, or null if the data does not support one) and confidence (high, medium or low).",
  // 경로·hop·단계 제목은 데이터라 번역하면 원본 기록과 맞춰 볼 수 없다. 수정안의 기계 값은 엔진·사람이 그대로 쓴다.
  "Keep paths, HTTP methods, hop chains, step titles, environment names and fix.target, fix.option, fix.value and fix.native as they appear in the data.",
  "In fix, target is the environment name. Always set auto_applicable to false; a person reviews and applies the fix.",
  // aiReport는 자동 적용 가능한 규칙 수정안을 그대로 유지한다. AI가 다른 수정안을 권하는 문장을 쓰지 않게 미리 알린다.
  "If rule_report.fix.auto_applicable is true, that fix is applied as is, so explain the cause consistently with it.",
].join(" ");

/** lang: 보고서 언어(없으면 en). fallback(규칙 보고서)도 같은 언어로 만들어 넘긴다. */
export type AiInput = { diffs: StepDiff[]; verdict: Verdict; fallback: Report | null; hints?: Record<string, unknown>; lang?: Lang };
export type AiOptions = {
  client?: Anthropic;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  usdToKrw?: number;
};

/** ANTHROPIC_API_KEY가 있을 때만 AI를 켠다. SHAKEDOWN_AI_REPORT=off는 키가 있어도 끈다. */
export function aiOptionsFromEnv(env: Record<string, string | undefined> = process.env): AiOptions {
  if (env.SHAKEDOWN_AI_REPORT === "off" || !env.ANTHROPIC_API_KEY) return {};
  return { apiKey: env.ANTHROPIC_API_KEY };
}

/** options로 Claude 클라이언트를 만든다. client도 키도 없으면 null(AI 꺼짐). AI 시나리오(ai-scenario.ts)도 같은 설정을 쓴다. */
export function clientOf(options: AiOptions): Anthropic | null {
  return options.client ?? (options.apiKey ? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: MAX_RETRIES }) : null);
}

/** 빈 비용. 필드가 늘 때 한곳만 고치게 비용 0은 이것으로 만든다. */
export const noCost = (): CostLedger => ({ calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 });

/** 응답 한 번의 비용. 대시보드가 ₩{krw}로 그대로 찍으므로 소수 둘째 자리까지만 남긴다. */
export function costOf(usage: { input_tokens: number; output_tokens: number }, usdToKrw = USD_TO_KRW): CostLedger {
  const { input_tokens, output_tokens } = usage;
  const krw = Math.round(((input_tokens * USD_PER_MTOK_IN + output_tokens * USD_PER_MTOK_OUT) * usdToKrw) / 1e4) / 100;
  return { calls: 1, input_tokens, output_tokens, krw };
}

function side(r: StepResult) {
  return { final_path: r.final_path, final_status: r.final_status, failed_checks: r.checks.filter((c) => !c.ok).map((c) => c.detail) };
}

function promptData(input: AiInput): string {
  const steps = input.diffs
    .filter((d) => d.severity === "critical" || d.severity === "warn")
    .map((d) => ({
      index: d.index,
      title: d.title,
      kind: d.kind,
      reasons: d.reasons,
      baseline: { env: d.baseline, ...side(d.local) },
      // 응답 서버 ID를 hop마다 붙인다. SYSTEM이 "데이터에 없는 건 주장하지 말라"고 하므로, 서버가 바뀐 것을 AI가 데이터로 직접 볼 수 있어야 한다.
      candidate: { env: d.candidate, ...side(d.cloud), hops: d.cloud.hops.map((h) => `${h.method} ${h.path} ${h.status}${h.instance ? ` [${h.instance}]` : ""}`) },
    }));
  return JSON.stringify({ diverging_steps: steps, rule_report: input.fallback, hints: input.hints ?? {} });
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isFix(v: unknown): v is Fix {
  return isObject(v) && FIX_TEXT_FIELDS.every((k) => typeof v[k] === "string") && typeof v.auto_applicable === "boolean";
}

// 구조화 출력이 스키마를 강제해도, 대체 모델이 답했거나 응답이 잘린 경우까지 보장하지는 않아서 직접 다시 검사한다.
function parseReport(raw: string): Report | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const { headline, cause, evidence, fix, confidence } = v;
  if (typeof headline !== "string" || typeof cause !== "string") return null;
  if (typeof confidence !== "string" || !CONFIDENCE.includes(confidence)) return null;
  if (!Array.isArray(evidence) || !evidence.every((e) => typeof e === "string")) return null;
  if (fix !== null && !isFix(fix)) return null;
  // 모르는 키가 보고서에 섞여 나가지 않도록 계약에 있는 필드만 옮긴다.
  const picked: Fix | null = fix && {
    target: fix.target,
    option: fix.option,
    value: fix.value,
    description: fix.description,
    native: fix.native,
    // AI가 낸 수정안은 사람이 확인한 뒤 적용한다. 엔진이 자동으로 재배포하지 않게 항상 false로 둔다.
    auto_applicable: false,
  };
  return { headline, cause, evidence, fix: picked, confidence, by: "ai" };
}

/**
 * AI가 evidence를 다시 쓰면서 서버 ID 근거를 빠뜨리면, "다른 서버가 받았다"는 가장 직접적인 증거가 최종 보고서에서 사라진다.
 * AI는 rule_report 문장으로 그 줄을 보지만, 로그인이 앞 단계에서 끝났으면 그 단계는 프롬프트에 들어가지 않아(critical·warn만 보냄)
 * 로그인 서버 ID를 원본 hop으로는 보지 못한다. 그래서 규칙 줄이 AI evidence에 그대로 없으면 끝에 붙인다.
 * AI 글에서 ID를 찾아 "이미 말했다"고 보지 않는다. ID는 아무 문자열이라 "2"가 "302"에 걸리듯 엉뚱한 글과 겹친다.
 * 그 대가로 AI가 같은 내용을 다른 말로 썼으면 비슷한 줄이 두 번 보일 수 있다.
 */
function keepInstanceEvidence(report: Report, fallback: Report | null): Report {
  const line = fallback && switchLine(fallback.evidence);
  if (!line || report.evidence.includes(line)) return report;
  return { ...report, evidence: [...report.evidence, line] };
}

export async function aiReport(input: AiInput, options: AiOptions): Promise<{ report: Report | null; cost: CostLedger }> {
  const cost = noCost();
  if (input.verdict.status !== "BLOCKED") return { report: null, cost };

  const client = clientOf(options);
  if (!client) return { report: input.fallback, cost };

  const response = await client.beta.messages
    .create(
      {
        model: options.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: REPORT_SCHEMA } },
        system: system(input.lang ?? "en"),
        messages: [{ role: "user", content: promptData(input) }],
      },
      { timeout: options.timeoutMs ?? TIMEOUT_MS },
    )
    .catch((error: unknown) => {
      // 시간 초과(APIConnectionTimeoutError)와 연결 실패도 APIError의 하위 클래스다.
      if (error instanceof Anthropic.APIError) return null;
      throw error;
    });
  if (!response) return { report: input.fallback, cost };

  const spent = costOf(response.usage, options.usdToKrw);

  // 거절이면 content가 비었거나 스키마를 안 지킬 수 있어서, 내용을 읽기 전에 거른다.
  if (response.stop_reason === "refusal") return { report: input.fallback, cost: spent };
  const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const answer = parseReport(raw);
  const parsed = answer && keepInstanceEvidence(answer, input.fallback);
  // 엔진이 그대로 적용할 수정안은 규칙이 정한다. AI가 값을 바꾸거나 지우면 허용되지 않은 설정이 적용되거나
  // 적용 버튼이 사라지므로, 규칙 수정안이 자동 적용 가능이면 fix만 규칙 것으로 덮는다. headline·cause·evidence와
  // confidence는 AI 것을 쓴다(confidence는 AI가 자기 원인 설명을 얼마나 확신하는지라서 그 설명과 함께 간다).
  const pinned = input.fallback?.fix?.auto_applicable ? input.fallback.fix : null;
  if (parsed && pinned) return { report: { ...parsed, fix: pinned }, cost: spent };
  return { report: parsed ?? input.fallback, cost: spent };
}
