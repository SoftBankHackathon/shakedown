// 요청에 시나리오가 없고 알려진 시나리오도 맞지 않을 때, 기준 환경을 둘러본 결과로 Claude에게 시나리오를 받는다.
// AI는 시나리오만 쓰고 판정은 하지 않는다. 받은 시나리오는 여기서 모양을 검사하고, 기준 환경에서 미리 돌려 본 뒤에만 쓴다(choose.ts).
// 호출 방식(모델·구조화 출력·fallback·재시도 없음·APIError면 포기)은 AI 보고서(ai-report.ts)와 같다.
import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger, Scenario, Step } from "@shakedown/contracts";
import { clientOf, costOf, FALLBACK_BETA, isObject, LANG_NAME, MODEL, noCost, type AiOptions } from "./ai-report.ts";
import type { Lang } from "./report.ts";
import { isScenario } from "./scenario.ts";
import { fillStep, makeValues } from "./placeholders.ts";
import { follow, isDataPath, type CrawledPage } from "./crawl.ts";
import { isForbidden } from "./steps.ts";

const MAX_STEPS = 8;
// 시운전 마감(150초) 안에서 이 시간보다 길게 기다리지 않는다. 실제 상한은 choose.ts가 남은 시간으로 다시 줄인다.
export const AI_SCENARIO_TIMEOUT_MS = 25_000;
// 시나리오는 보고서보다 길고, Opus 5.5는 생각 토큰도 max_tokens에 들어가서 보고서(4000)보다 넉넉히 잡는다.
const MAX_TOKENS = 6000;
// 고정값을 넣어도 되는 입력칸 종류. 고르는 칸과 숫자·날짜 칸이다(전화번호·이메일·글자 칸은 계정·글마다 달라야 할 수 있어 뺀다).
const FIXED_OK = ["select", "radio", "checkbox", "number", "range", "date", "time", "datetime-local", "month", "week", "color"];
// 자리표시자는 makeValues가 만드는 값만 쓸 수 있다. 목록을 한곳(placeholders.ts)에서만 관리한다.
const PLACEHOLDERS = Object.keys(makeValues("000000")).map((key) => `{{${key}}}`);

const text = { type: "string" };
const textOrNull = { anyOf: [text, { type: "null" }] };
// 구조화 출력은 모든 객체에 additionalProperties: false가 필요하고 배열 길이 제한(maxItems)은 받지 않는다. 8단계 제한은 받은 뒤에 검사한다.
const SCENARIO_SCHEMA = {
  type: "object",
  properties: {
    app_understanding: text,
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: text,
          action: { type: "string", enum: ["visit", "submit_form", "click_link"] },
          path: textOrNull,
          form_action: textOrNull,
          link_text: textOrNull,
          fields: {
            type: "array",
            items: { type: "object", properties: { name: text, value: text }, required: ["name", "value"], additionalProperties: false },
          },
          expect: {
            type: "object",
            properties: { path_startswith: textOrNull, text_contains: { type: "array", items: text } },
            required: ["path_startswith", "text_contains"],
            additionalProperties: false,
          },
        },
        required: ["title", "action", "path", "form_action", "link_text", "fields", "expect"],
        additionalProperties: false,
      },
    },
  },
  required: ["app_understanding", "steps"],
  additionalProperties: false,
};

const system = (lang: Lang) => [
  "You write a short end-to-end test scenario for a web app. The same scenario runs on a baseline and a candidate deploy environment to check that they behave the same.",
  "The user message has pages crawled from the baseline with GET requests only (path, final_path, status, title, text, links, forms) and hints from a repo analysis.",
  `Use only paths, links and forms from the data. Write at most ${MAX_STEPS} steps and start with a visit step.`,
  "Actions: visit (path: a path on the same site starting with /, without a query string; search through GET forms with submit_form instead), submit_form (form_action: the exact action of a form on the page the previous step ended on;",
  "fields: name and value pairs; hidden inputs are sent automatically, so leave them out), click_link (link_text: visible text of a link on the current page).",
  `Placeholders: ${PLACEHOLDERS.join(" ")}. Every value you type into a field must use one of them (the scenario runs more than once, so fixed values would collide);`,
  "fixed text is allowed only for select, radio, checkbox, number and date-like inputs seen in the forms. Expected text may use placeholders or fixed text.",
  "Never delete anything, log out, pay, or use admin features.",
  "After a step that writes data, check with expect.text_contains that the written placeholder value is shown, on that page or after a following visit.",
  "Each environment has its own database and the scenario runs more than once on the same database, so do not expect text that depends on stored data",
  "(empty lists, counts, dates, other users' content) and do not visit paths that contain record ids.",
  "Set expect.path_startswith only when the step must end on a known path. app_understanding: one sentence on what the app does and what the scenario covers.",
  // 제목·설명은 대시보드에 그대로 보이므로 요청 언어로 받는다. 경로·폼 값·링크 글자·expect 글자는 화면의 데이터라
  // 번역하면 기준 환경에서도 맞지 않아 시나리오가 버려진다(ko·ja에서만 생기는 손해).
  `Write step titles (short imperative phrases) and app_understanding in ${LANG_NAME[lang]}.`,
  "Do not translate paths, form actions, field names, field values, link texts, expected text or placeholders; copy them exactly as they appear on the pages.",
].join(" ");

/** ANTHROPIC_API_KEY가 있을 때만 켠다. SHAKEDOWN_AI_SCENARIO=off는 AI 시나리오만 끈다(AI 보고서 스위치 SHAKEDOWN_AI_REPORT와 따로). */
export function aiScenarioOptionsFromEnv(env: Record<string, string | undefined> = process.env): AiOptions {
  if (env.SHAKEDOWN_AI_SCENARIO === "off" || !env.ANTHROPIC_API_KEY) return {};
  return { apiKey: env.ANTHROPIC_API_KEY };
}

const isText = (v: unknown): v is string => typeof v === "string";
const textOr = (v: unknown): string | null | undefined => (v == null ? null : isText(v) ? v : undefined);

/** 계약에 있는 칸만 옮긴다. 빠진 선택 칸은 null·빈 배열로 채우고, 타입이 틀리면 null. */
function toStep(v: Record<string, unknown>): Step | null {
  const expect = isObject(v.expect) ? v.expect : {};
  const fields = v.fields ?? [];
  const textContains = expect.text_contains ?? [];
  const [path, formAction, linkText, pathStartsWith] = [v.path, v.form_action, v.link_text, expect.path_startswith].map(textOr);
  if (path === undefined || formAction === undefined || linkText === undefined || pathStartsWith === undefined) return null;
  if (!Array.isArray(fields) || !fields.every((f) => isObject(f) && isText(f.name) && isText(f.value))) return null;
  if (!Array.isArray(textContains) || !textContains.every(isText)) return null;
  return {
    title: v.title as string,
    action: v.action as Step["action"],
    path,
    form_action: formAction,
    link_text: linkText,
    fields: fields.map((f) => ({ name: f.name as string, value: f.value as string })),
    expect: { path_startswith: pathStartsWith, text_contains: textContains },
  };
}

const BASE = new URL("http://placeholder/");

/**
 * 실행할 수 있고 시운전이 해도 되는 단계인지. 비어 있지 않은 폼·링크, 지우기·로그아웃·관리자·결제 아님.
 * visit 경로는 둘러보기가 여는 주소와 같은 규칙(follow)을 지켜야 한다: 같은 출처, 쿼리·데이터 주소(/posts/1, ?id=6) 아님.
 * 환경마다 DB가 따로라 데이터 주소는 기준 환경에서 통과해도 비교 환경엔 없어 거짓 차단이 된다. "//host"·"/\host"도 다른 출처로 풀린다.
 */
function usable(step: Step): boolean {
  if (step.action === "visit" && (!step.path?.startsWith("/") || follow(step.path, BASE) !== step.path)) return false;
  if (step.expect.path_startswith && isDataPath(step.expect.path_startswith)) return false;
  if (step.action === "submit_form" && !step.form_action) return false;
  if (step.action === "click_link" && !step.link_text) return false;
  const targets = [step.path, step.form_action, step.link_text].filter(isText);
  // 지우기·로그아웃과 관리자·결제가 받은 단계의 경로·폼·링크 글자에 있으면 시나리오를 버린다.
  return !targets.some(isForbidden);
}

/**
 * 입력값마다 자리표시자가 있는지. 미리 돌리기가 기준 환경에 먼저 쓰므로, 고정값으로 가입·글쓰기를 하면 본 실행에서
 * '이미 있음'으로 실패한다. 둘러본 폼에서 겹칠 일 없는 칸(FIXED_OK)으로 본 칸만 고정값을 허락한다. 자리표시자는 모두 글자라 숫자·날짜 칸은 고정값이어야 한다.
 */
function freshValues(step: Step, choices: Set<string>): boolean {
  return step.fields.every((f) => /\{\{\w+\}\}/.test(f.value) || choices.has(f.name));
}

// 구조화 출력이 스키마를 강제해도, 대체 모델이 답했거나 응답이 잘린 경우까지 보장하지는 않아서 직접 다시 검사한다.
function parseScenario(raw: string, pages: CrawledPage[]): Scenario | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isScenario(v) || !isText(v.app_understanding) || v.steps.length > MAX_STEPS) return null;
  const choices = new Set(pages.flatMap((p) => p.forms.flatMap((f) => f.inputs.filter((i) => FIXED_OK.includes(i.type)).map((i) => i.name))));
  const steps = v.steps.map((s) => toStep(s as Record<string, unknown>));
  if (!steps.every((s): s is Step => s !== null && usable(s) && freshValues(s, choices))) return null;
  // 모르는 자리표시자가 있으면 fillStep이 예외를 던진다. 실행 도중이 아니라 여기서 버린다.
  const values = makeValues();
  try {
    for (const s of steps) fillStep(s, values);
  } catch {
    return null;
  }
  return { app_understanding: v.app_understanding, steps };
}

/**
 * 둘러본 결과로 시나리오를 받는다. AI가 꺼져 있거나, 실패·거절했거나, 쓸 수 없는 시나리오면 scenario는 null.
 * signal은 시운전 마감이다. 취소되면 요청도 끊어서 마감 뒤까지 기다리지 않는다.
 */
export async function aiScenario(
  input: { pages: CrawledPage[]; hints?: Record<string, unknown>; lang?: Lang },
  options: AiOptions & { signal?: AbortSignal },
): Promise<{ scenario: Scenario | null; cost: CostLedger }> {
  const cost = noCost();
  const client = clientOf(options);
  if (!client) return { scenario: null, cost };

  const response = await client.beta.messages
    .create(
      {
        model: options.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCENARIO_SCHEMA } },
        system: system(input.lang ?? "en"),
        messages: [{ role: "user", content: JSON.stringify({ pages: input.pages, hints: input.hints ?? {} }) }],
      },
      { timeout: options.timeoutMs ?? AI_SCENARIO_TIMEOUT_MS, signal: options.signal },
    )
    .catch((error: unknown) => {
      // 시간 초과(APIConnectionTimeoutError), 연결 실패, 취소(APIUserAbortError)도 APIError의 하위 클래스다.
      if (error instanceof Anthropic.APIError) return null;
      throw error;
    });
  if (!response) return { scenario: null, cost };

  const spent = costOf(response.usage, options.usdToKrw);
  // 거절이면 content가 비었거나 스키마를 안 지킬 수 있어서, 내용을 읽기 전에 거른다.
  if (response.stop_reason === "refusal") return { scenario: null, cost: spent };
  const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { scenario: parseScenario(raw, input.pages), cost: spent };
}
