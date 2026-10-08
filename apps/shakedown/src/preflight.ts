// 대상 주소가 응답할 때까지 잠깐 기다린다.
// Quick Tunnel 주소는 막 만든 직후 DNS가 늦게 잡힐 때가 있어서, 바로 첫 단계를 돌리면 BLOCKED로 잘못 판정된다.
// 어떤 HTTP 응답이든(500 포함) 오면 닿은 것으로 본다. 판정은 시나리오가 한다.
export async function waitUntilReachable(
  url: string,
  options: { waitMs?: number; intervalMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const waitMs = options.waitMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
      await res.body?.cancel();
      return true;
    } catch {
      if (Date.now() + intervalMs > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
