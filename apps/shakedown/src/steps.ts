// 시나리오 단계를 하나씩 실행해서 contracts의 StepResult를 만든다.
import type { Step, StepResult } from "@shakedown/contracts";
import type { Page, Session } from "./http.ts";
import { findForm, findLinkByText, pageText } from "./html.ts";
import { checkExpect } from "./checks.ts";

/**
 * words 중 하나가 낱말로 들어 있는지 보는 함수를 만든다. 앞뒤가 글자면 낱말이 아니다(/blog-outline의 log-out, /badminton의 admin).
 * camelCase는 낱말로 나눠 본다(deleteAccount → delete Account).
 */
function wordMatcher(words: string): (text: string) => boolean {
  const re = new RegExp(`(?<![a-z])(${words})(?![a-z])`, "i");
  return (text) => re.test(text.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

/**
 * 시운전이 건드리지 않는 주소·글자: GET이어도 상태를 바꾸는 로그아웃·삭제와, 관리자·결제 기능.
 * 실행 중에 이런 링크·폼을 보내지 않고, 둘러보기와 AI 시나리오 검사도 이것을 쓴다.
 */
export const isForbidden = wordMatcher("log[\\s_-]?out|sign[\\s_-]?out|delete|remove|destroy|admin\\w*|checkout|payments?|billing|purchases?");

function pathOf(href: string): string {
  const url = new URL(href, "http://placeholder");
  return url.pathname + url.search;
}

async function act(session: Session, step: Step): Promise<Page> {
  if (step.action === "visit") {
    if (!step.path) throw new Error("visit step has no path");
    return session.request("GET", step.path);
  }

  if (step.action === "submit_form") {
    const form = findForm(session.lastHtml(), step.form_action ?? "");
    if (!form) throw new Error(`form ${step.form_action} not found on the current page`);
    const fields = { ...form.fields, ...Object.fromEntries(step.fields.map((f) => [f.name, f.value])) };
    // AI가 쓴 시나리오가 삭제(숨은 _method=delete 포함)·결제 폼을 고르더라도 기준·비교 환경의 데이터를 지우거나 결제하지 않게 보내지 않는다.
    if (isForbidden(form.action) || fields._method?.toLowerCase() === "delete") {
      throw new Error(`form ${step.form_action} looks unsafe (delete, log out, admin or payment); not submitted`);
    }
    // GET 폼은 브라우저처럼 값을 쿼리로 붙인다. fetch는 GET 요청에 본문을 허용하지 않는다.
    if (form.method === "GET") {
      const target = new URL(form.action, "http://placeholder");
      for (const [name, value] of Object.entries(fields)) target.searchParams.set(name, value);
      return session.request("GET", target.pathname + target.search);
    }
    return session.request(form.method, form.action, fields);
  }

  // 빈 글자는 모든 링크에 들어 있어서, 비어 있으면 아무 링크(로그아웃 등)나 누르게 된다.
  if (!step.link_text) throw new Error("click_link step has no link_text");
  const href = findLinkByText(session.lastHtml(), step.link_text);
  if (!href) throw new Error(`link "${step.link_text}" not found on the current page`);
  // 링크는 글자 일부만 맞아도 첫 링크를 고른다. "post"가 "Delete post"를 고를 수 있어서 간 곳 주소로 한 번 더 거른다.
  if (isForbidden(pathOf(href))) throw new Error(`link "${step.link_text}" goes to ${pathOf(href)}, which looks unsafe (delete, log out, admin or payment); not followed`);
  return session.request("GET", pathOf(href));
}

export async function runStep(session: Session, step: Step, index: number): Promise<StepResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const page = await act(session, step);
    const checks = checkExpect(step.expect, page.finalPath, page.finalStatus, pageText(page.html));
    const failed = checks.find((c) => !c.ok);
    return {
      index,
      title: step.title,
      status: failed ? "failed" : "passed",
      error: failed ? failed.detail : null,
      final_path: page.finalPath,
      final_status: page.finalStatus,
      hops: page.hops,
      checks,
      elapsed_ms: elapsed(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      index,
      title: step.title,
      status: "failed",
      error: `request failed: ${message}`,
      final_path: null,
      final_status: null,
      hops: [],
      checks: [],
      elapsed_ms: elapsed(),
    };
  }
}

/**
 * 단계를 순서대로 실행한다. 한 단계가 실패하면 나머지는 skipped로 채운다.
 * onResult는 단계 결과가 하나 나올 때마다 불린다. API가 진행 상황을 보여 주는 데 쓴다.
 */
export async function runScenario(session: Session, steps: Step[], onResult?: (result: StepResult) => void): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    if (results.some((r) => r.status !== "passed")) {
      results.push({
        index: i + 1,
        title: step.title,
        status: "skipped",
        error: "an earlier step failed",
        final_path: null,
        final_status: null,
        hops: [],
        checks: [],
        elapsed_ms: 0,
      });
      onResult?.(results[i]);
      continue;
    }
    results.push(await runStep(session, step, i + 1));
    onResult?.(results[i]);
  }
  return results;
}
