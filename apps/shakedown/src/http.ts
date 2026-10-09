import { targetFetch, tunnelNotReady } from "./transport.ts";
import type { RequestInit, Response } from "undici";
import { setTimeout as delay } from "node:timers/promises";
// 대상 사이트 하나를 브라우저처럼 돌아다니는 HTTP 세션.
// 쿠키를 직접 보관하고, 리다이렉트(3xx)를 직접 따라가며 거쳐 간 주소(hop)를 모두 기록한다.
// 단, 다시 보낸 Cloudflare 엣지 530(터널 미준비)은 앱이 본 적 없는 응답이라 hop에 남기지 않는다(아래 send).
import type { Hop } from "@shakedown/contracts";

export type Page = { hops: Hop[]; finalPath: string; finalStatus: number; html: string };
export type Session = ReturnType<typeof createSession>;

const MAX_REDIRECTS = 10;
// 접속 확인을 통과한 뒤에도 터널이 잠깐 Cloudflare 530(터널 미준비)을 낼 때가 있다(10/9 엔진 e2e에서 Local ready 직후 1단계가 HTTP 530으로 실패).
// 그 530은 엣지가 앱에 넘기기 전에 만든 응답이라 POST여도 앱은 받은 적이 없다 → 메서드와 상관없이 다시 보낸다.
// 다만 끝없이 기다리면 시운전 마감(150초)을 잡아먹으므로 1초 간격으로 요청 하나(리다이렉트 포함, 곧 단계 하나)에 10초까지만 기다린다.
const TUNNEL_WAIT_MS = 10_000;
const TUNNEL_INTERVAL_MS = 1_000;

// 서버는 쿠키를 지울 때 Max-Age=0이나 지난 Expires를 보낸다. 브라우저처럼 그 쿠키를 버린다.
function isExpired(attrs: string[]): boolean {
  return attrs.some((attr) => {
    const eq = attr.indexOf("=");
    const key = attr.slice(0, eq < 0 ? undefined : eq).trim().toLowerCase();
    const value = eq < 0 ? "" : attr.slice(eq + 1).trim();
    return (key === "max-age" && Number(value) <= 0) || (key === "expires" && Date.parse(value) <= Date.now());
  });
}

export function createSession(
  baseUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal; tunnelWaitMs?: number; tunnelIntervalMs?: number } = {},
) {
  const base = new URL(baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tunnelWaitMs = options.tunnelWaitMs ?? TUNNEL_WAIT_MS;
  const tunnelIntervalMs = options.tunnelIntervalMs ?? TUNNEL_INTERVAL_MS;
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

  // 터널 미준비 530은 앱이 본 적 없는 응답이라 쿠키도 hop도 남기지 않고 버린 뒤 다시 보낸다.
  // 기다릴 시간이 다 되면 마지막 530을 그대로 돌려준다 → 그 단계는 'HTTP 530'으로 실패한다.
  // giveUpAt은 request()가 한 번만 정한다. hop마다 새로 잡으면 리다이렉트가 이어질 때 hop 수 × 10초까지 늘어난다.
  async function send(url: URL, init: RequestInit, giveUpAt: number): Promise<Response> {
    for (;;) {
      const res = await targetFetch(url, {
        ...init,
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!tunnelNotReady(res) || Date.now() + tunnelIntervalMs > giveUpAt) return res;
      await res.body?.cancel();
      await delay(tunnelIntervalMs, undefined, { signal: options.signal });
    }
  }

  async function request(method: string, path: string, form?: Record<string, string>): Promise<Page> {
    const hops: Hop[] = [];
    let url = onTarget(new URL(path, base));
    let body: URLSearchParams | undefined = form ? new URLSearchParams(form) : undefined;
    const giveUpAt = Date.now() + tunnelWaitMs;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await send(url, { method, body, headers: cookies.size ? { cookie: cookieHeader() } : {} }, giveUpAt);
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
