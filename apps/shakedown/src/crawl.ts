// 요청에 시나리오가 없고 알려진 시나리오도 맞지 않을 때, 기준 환경을 GET으로만 둘러본다.
// 둘러본 결과는 AI 시나리오의 재료가 되고, AI가 없거나 실패하면 열린 페이지를 그대로 visit 단계로 만든다(규칙 둘러보기).
// 둘러보기는 기준 환경에 흔적을 남기면 안 되므로 쓰기 요청은 보내지 않는다.
import type { Scenario } from "@shakedown/contracts";
import { createSession } from "./http.ts";
import { normalizePath } from "./compare.ts";
import { listForms, listLinks, pageText, pageTitle, type FormSummary } from "./html.ts";

export type CrawledPage = {
  /** 연 경로 */
  path: string;
  /** 리다이렉트를 따라간 뒤의 경로. 응답이 없으면 null */
  final_path: string | null;
  status: number | null;
  title: string;
  /** 화면 글자 앞부분. JSON만 주는 앱은 제목·링크가 없어서 이것으로 무엇을 하는 앱인지 짐작한다. */
  text: string;
  links: Array<{ text: string; path: string }>;
  forms: FormSummary[];
  error: string | null;
};

// 페이지 수와 시간을 묶어 둔다. 시운전 전체 마감(150초) 안에 AI 시나리오·실행·보고서까지 들어가야 한다.
const MAX_PAGES = 6;
const CRAWL_MS = 15_000;
// AI에게 보낼 프롬프트가 한없이 커지지 않게 페이지마다 자른다.
const MAX_LINKS = 30;
const TEXT_CHARS = 300;

/** GET이어도 상태를 바꾸는 흔한 주소(로그아웃·삭제). 둘러보기에서 열지 않고, AI 시나리오에서도 받지 않는다. */
export const UNSAFE = /log-?out|sign-?out|delete|remove|destroy/i;
// 화면이 아닌 정적 파일은 비교할 사용자 흐름이 아니다.
const STATIC = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|zip|txt|xml)$/i;
/** 관리자·결제 기능. 시운전이 건드리면 안 되므로 둘러보기에서 열지 않고 AI에게도 주지 않는다(AI 시나리오에 있으면 버린다). */
export const OFF_LIMITS = /admin|checkout|payment|billing|purchase/i;
// 데이터마다 다른 경로 칸(숫자·ObjectId·UUID)이 있는 주소. 칸을 고르는 규칙은 단계 비교(compare.ts)와 같다.
export const isDataPath = (path: string) => normalizePath(path) !== path;
// 경로만 남긴다. 쿼리와 ;jsessionid=… 같은 경로 매개변수는 세션마다 달라서 같은 화면이 다른 주소로 두 번 열리지 않게 뗀다.
const pathOnly = (url: URL) => url.pathname.split(";")[0];

/**
 * 따라갈 같은 출처 경로. 다른 출처(mailto·javascript 포함)·정적 파일·로그아웃류·관리자·결제·데이터 주소면 null.
 * AI 시나리오의 visit 경로도 이 규칙으로 검사한다(ai-scenario.ts). 둘러보기와 AI가 여는 주소의 규칙을 한곳에 둔다.
 */
export function follow(href: string, from: URL): string | null {
  if (!URL.canParse(href, from)) return null;
  const url = new URL(href, from);
  const path = pathOnly(url);
  if (url.origin !== from.origin || STATIC.test(path) || UNSAFE.test(path) || OFF_LIMITS.test(path)) return null;
  // 데이터마다 다른 주소는 빼낸다. 환경마다 DB가 따로라 기준 환경의 /posts/6·?id=6·?page=2가 비교 환경엔 없어 거짓 차단이 된다.
  // 쿼리가 붙은 링크는 대개 이런 주소(번호·검색·쪽 번호)라서 따라가지 않는다. slug(/posts/my-first-post)는 모양으로 알 수 없어 남는다.
  if (url.search || isDataPath(path)) return null;
  return path;
}

/**
 * "/"(와 healthPath)부터 같은 출처 링크를 따라 최대 MAX_PAGES(+health) 페이지를 연다. 순서는 너비 우선.
 * 응답이 없는 페이지는 error를 남기고 넘어간다. 둘러보기 시간(CRAWL_MS)이 다 되거나 signal이 취소되면 거기서 멈춘다.
 */
export async function crawl(baseUrl: string, options: { healthPath?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CrawledPage[]> {
  const base = new URL(baseUrl);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(CRAWL_MS)]);
  const session = createSession(baseUrl, { timeoutMs: options.timeoutMs, signal });
  // hints는 자유 형식이라 모양을 믿지 않는다. "/"로 시작하는 같은 출처 경로일 때만 연다.
  const health = typeof options.healthPath === "string" && options.healthPath.startsWith("/") ? follow(options.healthPath, base) : null;
  const queue = health && health !== "/" ? ["/", health] : ["/"];
  const limit = MAX_PAGES + queue.length - 1;
  const seen = new Set(queue);
  const pages: CrawledPage[] = [];

  while (queue.length && pages.length < limit) {
    const path = queue.shift()!;
    try {
      const page = await session.request("GET", path);
      const here = new URL(page.finalPath, base);
      seen.add(pathOnly(here));
      const links = new Map<string, string>();
      for (const link of listLinks(page.html)) {
        const to = follow(link.href, here);
        if (to === null || links.has(to)) continue;
        links.set(to, link.text);
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
      pages.push({
        path,
        final_path: page.finalPath,
        status: page.finalStatus,
        title: pageTitle(page.html),
        text: pageText(page.html).slice(0, TEXT_CHARS),
        links: [...links].slice(0, MAX_LINKS).map(([to, text]) => ({ text, path: to })),
        forms: listForms(page.html).filter((f) => !UNSAFE.test(f.action) && !OFF_LIMITS.test(f.action)),
        error: null,
      });
    } catch (err) {
      if (signal.aborted) break;
      pages.push({ path, final_path: null, status: null, title: "", text: "", links: [], forms: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return pages;
}

/** 규칙 둘러보기 시나리오: 기준 환경에서 HTTP 400 미만이었던 페이지를 하나씩 연다. 그런 페이지가 없으면 null. */
export function crawlScenario(pages: CrawledPage[]): Scenario | null {
  const ok = pages.filter((p) => p.status !== null && p.status < 400);
  if (!ok.length) return null;
  return {
    app_understanding: `Rule-based crawl of ${ok.length} page${ok.length === 1 ? "" : "s"} (AI unavailable)`,
    steps: ok.map((p) => {
      // 기준 환경에서 다른 화면(로그인 화면 등)으로 넘어갔으면 비교 환경도 그 화면으로 가야 한다.
      // 쿼리와 ;jsessionid=… 같은 경로 매개변수는 세션마다 달라서 그 앞의 경로만 본다.
      // 넘어간 곳이 글 번호 같은 데이터 주소면 환경마다 번호가 달라서 기대하지 않는다(경로 비교는 번호를 같은 것으로 보는 compare.ts가 맡는다).
      const landed = p.final_path !== p.path ? pathOnly(new URL(p.final_path!, "http://placeholder")) : null;
      const expected = landed !== null && !isDataPath(landed) ? landed : null;
      return {
        title: `Open ${p.path}`,
        action: "visit" as const,
        path: p.path,
        form_action: null,
        fields: [],
        link_text: null,
        expect: { path_startswith: expected, text_contains: [] },
      };
    }),
  };
}
