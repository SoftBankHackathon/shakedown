import { targetFetch } from "./transport.ts";
import { setTimeout as delay } from "node:timers/promises";
// 대상 주소가 응답할 때까지 잠깐 기다린다.
// Quick Tunnel 주소는 막 만든 직후 DNS가 늦게 잡힐 때가 있어서, 바로 첫 단계를 돌리면 BLOCKED로 잘못 판정된다.
// 어떤 HTTP 응답이든(500 포함) 오면 닿은 것으로 본다. 판정은 시나리오가 한다.
export async function waitUntilReachable(
  url: string,
  options: { waitMs?: number; intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const waitMs = options.waitMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const res = await targetFetch(url, { redirect: "manual", signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 5_000)]) });
      await res.body?.cancel();
      return true;
    } catch {
      options.signal?.throwIfAborted();
      if (Date.now() + intervalMs > deadline) return false;
      await delay(intervalMs, undefined, { signal: options.signal });
    }
  }
}
