import { lookup } from "node:dns/promises";
import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch, type RequestInit } from "undici";

const tunnelHost = (host: string) => /^[a-z0-9-]+\.trycloudflare\.com$/.test(host);
const resolveTunnel = async (host: string): Promise<string[]> => {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  return resolver.resolve4(host);
};

/** Same fallback as Local Target publicHealth: only a Quick Tunnel DNS miss.
 * Keep the original HTTPS hostname/SNI and certificate verification. No OS DNS changes.
 * Resolution happens before connection; never retry a submitted POST.
 */
export function createTunnelLookup(
  system: (host: string) => Promise<LookupAddress[]> = host => lookup(host, { all: true }),
  fallback: (host: string) => Promise<string[]> = resolveTunnel,
): LookupFunction {
  return (host, options, callback) => {
    void (async () => {
      let addresses: LookupAddress[];
      try { addresses = await system(host); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!tunnelHost(host) || !["ENOTFOUND", "EAI_AGAIN"].includes(code ?? "")) throw error;
        addresses = (await fallback(host)).map(address => ({ address, family: 4 }));
      }
      if (!addresses.length) throw new Error("No DNS addresses returned");
      callback(null, options.all ? addresses : addresses[0].address, addresses[0].family);
    })().catch(error => callback(error, "", 0));
  };
}

const tunnelAgent = new Agent({ connect: { lookup: createTunnelLookup() } });
export function targetFetch(url: string | URL, options: RequestInit = {}) {
  const target = new URL(url);
  return fetch(target, {
    ...options,
    ...(target.protocol === "https:" && tunnelHost(target.hostname) ? { dispatcher: tunnelAgent } : {}),
  });
}
