// BLOCKED 판정의 원인 보고서를 Claude에게 받는다.
// AI는 선택 기능이다. 꺼져 있거나 실패하면 규칙 보고서(fallback)를 그대로 돌려준다.
import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger, Fix, Report, StepDiff, StepResult } from "@shakedown/contracts";
import type { Verdict } from "./verdict.ts";

// 가격 출처: claude-api 스킬 shared/models.md 모델 표(2026-09-25 캐시). claude-opus-5-5는 100만 토큰당 입력 $4, 출력 $20
const MODEL = "claude-opus-5-5";
const USD_PER_MTOK_IN = 4;
const USD_PER_MTOK_OUT = 20;
const USD_TO_KRW = 1400;
const TIMEOUT_MS = 20_000;
// 재시도하면 최악의 경우 시간이 두 배가 되어 시운전 마감(150초)을 위협한다. 한 번만 시도하고 실패하면 규칙 보고서로 간다.
const MAX_RETRIES = 0;
// Opus 5.5는 생각(thinking)을 끌 수 없고 그 토큰도 max_tokens에 들어가서, 보고서 길이보다 넉넉히 잡는다.
const MAX_TOKENS = 4000;
// fallbacks: "default"(거절 종류별로 서버가 대체 모델을 고름)는 이 날짜의 헤더와 짝이다. 배열 형식은 날짜가 달라 400이 난다.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

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

const SYSTEM = [
  "You explain why a web app behaves differently on a candidate deploy environment than on the baseline environment during an automated shakedown run.",
  "Use only the data in the user message. If the data does not show something, do not claim it; lower the confidence instead.",
  "rule_report is a rule-based guess that you may confirm or correct.",
  "Answer in English with: headline (one sentence), cause (two or three sentences), evidence (short facts taken from the data),",
  "fix (one setting change on the candidate environment, or null if the data does not support one) and confidence (high, medium or low).",
  "In fix, target is the environment name. Always set auto_applicable to false; a person reviews and applies the fix.",
].join(" ");

export type AiInput = { diffs: StepDiff[]; verdict: Verdict; fallback: Report | null; hints?: Record<string, unknown> };
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
      candidate: { env: d.candidate, ...side(d.cloud), hops: d.cloud.hops.map((h) => `${h.method} ${h.path} ${h.status}`) },
    }));
  return JSON.stringify({ diverging_steps: steps, rule_report: input.fallback, hints: input.hints ?? {} });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

export async function aiReport(input: AiInput, options: AiOptions): Promise<{ report: Report | null; cost: CostLedger }> {
  const cost: CostLedger = { calls: 0, input_tokens: 0, output_tokens: 0, krw: 0 };
  if (input.verdict.status !== "BLOCKED") return { report: null, cost };

  const client =
    options.client ?? (options.apiKey ? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: MAX_RETRIES }) : null);
  if (!client) return { report: input.fallback, cost };

  const response = await client.beta.messages
    .create(
      {
        model: options.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: REPORT_SCHEMA } },
        system: SYSTEM,
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

  const { input_tokens, output_tokens } = response.usage;
  const usdToKrw = options.usdToKrw ?? USD_TO_KRW;
  // 대시보드가 ₩{krw}로 그대로 찍으므로 소수 둘째 자리까지만 남긴다.
  const krw = Math.round(((input_tokens * USD_PER_MTOK_IN + output_tokens * USD_PER_MTOK_OUT) * usdToKrw) / 1e4) / 100;
  const spent = { calls: 1, input_tokens, output_tokens, krw };

  // 거절이면 content가 비었거나 스키마를 안 지킬 수 있어서, 내용을 읽기 전에 거른다.
  if (response.stop_reason === "refusal") return { report: input.fallback, cost: spent };
  const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { report: parseReport(raw) ?? input.fallback, cost: spent };
}
