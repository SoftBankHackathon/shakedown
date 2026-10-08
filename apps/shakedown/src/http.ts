import { targetFetch } from "./transport.ts";
import type { Response } from "undici";
// 대상 사이트 하나를 브라우저처럼 돌아다니는 HTTP 세션.
// 쿠키를 직접 보관하고, 리다이렉트(3xx)를 직접 따라가며 거쳐 간 주소(hop)를 모두 기록한다.
import type { Hop } from "@shakedown/contracts";

export type Page = { hops: Hop[]; finalPath: string; finalStatus: number; html: string };
export type Session = ReturnType<typeof createSession>;

const MAX_REDIRECTS = 10;

// 서버는 쿠키를 지울 때 Max-Age=0이나 지난 Expires를 보낸다. 브라우저처럼 그 쿠키를 버린다.
function isExpired(attrs: string[]): boolean {
  return attrs.some((attr) => {
    const eq = attr.indexOf("=");
    const key = attr.slice(0, eq < 0 ? undefined : eq).trim().toLowerCase();
    const value = eq < 0 ? "" : attr.slice(eq + 1).trim();
    return (key === "max-age" && Number(value) <= 0) || (key === "expires" && Date.parse(value) <= Date.now());
  });
}

export function createSession(baseUrl: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const base = new URL(baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cookies = new Map<string, string>();
  let lastHtml = "";

  function cookieHeader(): string {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function storeCookies(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || isExpired(attrs)) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  // 프록시 뒤의 앱이 내부 주소(localhost:8080 등)로 리다이렉트해도 대상 사이트를 벗어나지 않게 한다.
  function onTarget(url: URL): URL {
    return url.origin === base.origin ? url : new URL(url.pathname + url.search, base);
  }

  async function request(method: string, path: string, form?: Record<string, string>): Promise<Page> {
    const hops: Hop[] = [];
    let url = onTarget(new URL(path, base));
    let body: URLSearchParams | undefined = form ? new URLSearchParams(form) : undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await targetFetch(url, {
        method,
        body,
        headers: cookies.size ? { cookie: cookieHeader() } : {},
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      storeCookies(res);
      hops.push({ method, path: url.pathname + url.search, status: res.status, instance: res.headers.get("x-instance-id") });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = onTarget(new URL(location, url));
        // 307·308은 메서드와 본문을 그대로 다시 보내야 한다. 301·302·303은 브라우저처럼 GET으로 바꾼다.
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      lastHtml = await res.text();
      return { hops, finalPath: url.pathname + url.search, finalStatus: res.status, html: lastHtml };
    }
    throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
  }

  return {
    request,
    /** 마지막으로 받은 페이지의 HTML. 폼과 링크를 여기서 찾는다. */
    lastHtml: () => lastHtml,
  };
}
