import { Resolver, lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import ipaddr from "ipaddr.js";
import type { TLSSocket } from "node:tls";
import type { Binding, Check, DnsRecord } from "./model.js";
import { HttpsError } from "./model.js";
export function isPublic(ip: string): boolean {
  try {
    return ipaddr.process(ip).range() === "unicast";
  } catch {
    return false;
  }
}
export async function dnsCheck(
  records: DnsRecord[],
  resolver = new Resolver(),
): Promise<Check[]> {
  return Promise.all(
    records.map(async (r) => {
      try {
        const found =
          r.type === "CNAME"
            ? await resolver.resolveCname(r.name)
            : r.type === "A"
              ? await resolver.resolve4(r.name)
              : (await resolver.resolveTxt(r.name)).map((p) => p.join(""));
        const normalized = (x: string) => x.toLowerCase().replace(/\.$/, "");
        const ok = found.some((v) =>
          r.type === "TXT"
            ? v === r.value
            : normalized(v) === normalized(r.value),
        );
        return {
          name: "DNS " + r.type + " " + r.name,
          ok,
          detail: ok ? "등록 확인" : "안내된 레코드와 다릅니다.",
        };
      } catch {
        return {
          name: "DNS " + r.type + " " + r.name,
          ok: false,
          detail: "DNS 등록 또는 전파를 기다리고 있습니다.",
        };
      }
    }),
  );
}
export function createProber(
  resolve: typeof lookup = lookup,
  secureRequest: typeof httpsRequest = httpsRequest,
  plainRequest: typeof httpRequest = httpRequest,
) {
  return async function probe(url: string): Promise<{
    status: number;
    location?: string;
    issuer?: string;
    expires_at?: string;
    fingerprint?: string;
  }> {
    const u = new URL(url);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.port
    )
      throw new HttpsError(
        "INVALID_PROBE",
        "공개 표준 HTTP/HTTPS 주소만 검증합니다.",
      );
    const addresses = await resolve(u.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !isPublic(a.address)))
      throw new HttpsError(
        "UNSAFE_DNS",
        "공개 도메인이 비공개·예약 주소를 가리킵니다.",
      );
    const a = addresses[0];
    return new Promise((resolve, reject) => {
      const req = (u.protocol === "https:" ? secureRequest : plainRequest)(
        u,
        {
          method: "GET",
          // Each check must use the freshly resolved, pinned address and a new TLS handshake.
          agent: false,
          headers: { "user-agent": "Shakedown-HTTPS/1.0" },
          timeout: 10000,
          lookup: (_host: any, options: any, callback: any) =>
            options?.all
              ? callback(null, [a])
              : callback(null, a.address, a.family),
          ...(u.protocol === "https:"
            ? { rejectUnauthorized: true, servername: u.hostname }
            : {}),
        },
        (res) => {
          let cert: any = {};
          if (u.protocol === "https:") {
            const socket = res.socket as TLSSocket;
            if (!socket.authorized) {
              res.destroy();
              reject(new HttpsError("TLS_INVALID", "인증서 검증 실패"));
              return;
            }
            const peer = socket.getPeerCertificate();
            if (!Number.isFinite(Date.parse(peer.valid_to))) {
              res.destroy();
              reject(
                new HttpsError(
                  "TLS_INVALID",
                  "인증서 만료일을 확인할 수 없습니다.",
                ),
              );
              return;
            }
            cert = {
              issuer: peer.issuer?.O,
              expires_at: new Date(peer.valid_to).toISOString(),
              fingerprint: peer.fingerprint256,
            };
          }
          res.resume();
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            ...cert,
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () =>
        reject(
          new HttpsError(
            "TLS_OR_HEALTH_FAILED",
            "인증서·포트·HTTPS 연결을 확인하세요.",
            502,
          ),
        ),
      );
      req.end();
    });
  };
}
export const probe = createProber();
export type Prober = typeof probe;
export async function verify(
  j: Binding,
  path: string,
  redirect: boolean,
  run: Prober = probe,
) {
  const secure = await run("https://" + j.domain + path);
  if (secure.status !== 200)
    throw new HttpsError(
      "HTTPS_HEALTH_FAILED",
      "HTTPS 헬스체크가 200을 반환하지 않았습니다.",
      502,
    );
  if (!secure.expires_at || Date.parse(secure.expires_at) <= Date.now())
    throw new HttpsError(
      "TLS_INVALID",
      "인증서 유효기간을 확인할 수 없습니다.",
      502,
    );
  const checks: Check[] = [
    {
      name: "HTTPS 인증서 및 헬스체크",
      ok: true,
      detail: "인증서 검증 + HTTP 200",
    },
  ];
  if (redirect) {
    const route = "/__shakedown_https_check__?check=1&keep=2";
    const r = await run("http://" + j.domain + route);
    if (
      ![301, 302, 307, 308].includes(r.status) ||
      r.location !== "https://" + j.domain + route
    )
      throw new HttpsError(
        "REDIRECT_INVALID",
        "HTTP 리다이렉트가 도메인·경로·쿼리를 보존하지 않습니다.",
        502,
      );
    checks.push({
      name: "HTTP → HTTPS",
      ok: true,
      detail: "도메인·경로·쿼리 보존 확인",
    });
  }
  return {
    checks,
    certificate: {
      issuer: secure.issuer,
      expires_at: secure.expires_at,
      fingerprint: secure.fingerprint,
      renewal: "managed" as const,
    },
  };
}
