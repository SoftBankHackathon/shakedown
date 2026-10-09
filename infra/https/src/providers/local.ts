import type { Context, Provider, DnsRecord } from "../model.js";
import { HttpsError } from "../model.js";
import { isDeepStrictEqual } from "node:util";
import type { IO } from "../io.js";
export class CloudflareProvider implements Provider {
  constructor(private io: IO) {}
  async rest(c: Context, method: string, path: string, body?: unknown) {
    const a = c.job.config as any,
      token = process.env[a.tokenEnv];
    if (!token)
      throw new HttpsError(
        "CREDENTIAL_REQUIRED",
        "Cloudflare 토큰 참조가 준비되지 않았습니다.",
        422,
      );
    const result = await this.io.http(
      "https://api.cloudflare.com/client/v4" + path,
      method,
      body,
      { Authorization: "Bearer " + token },
    );
    if (result.success === false)
      throw new HttpsError(
        "CLOUDFLARE_FAILED",
        "Cloudflare 권한과 설정을 확인하세요.",
        502,
      );
    return result.result;
  }
  path(c: Context) {
    const a = c.job.config as any;
    return (
      "/accounts/" +
      a.accountId +
      "/cfd_tunnel/" +
      a.tunnelId +
      "/configurations"
    );
  }
  async prepare(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      domain = c.job.result.domain;
    const zone = await this.rest(c, "GET", "/zones/" + a.zoneId);
    if (
      zone.account.id !== a.accountId ||
      domain.split(".").slice(1).join(".") !== zone.name ||
      zone.status !== "active"
    )
      throw new HttpsError(
        "ZONE_REQUIRED",
        "활성 Cloudflare DNS 영역의 한 단계 서브도메인이 필요합니다.",
        422,
      );
    const tunnel = await this.rest(
      c,
      "GET",
      "/accounts/" + a.accountId + "/cfd_tunnel/" + a.tunnelId,
    );
    if (tunnel.config_src !== "cloudflare")
      throw new HttpsError(
        "RESOURCE_REQUIRED",
        "원격 관리 Named Tunnel이 필요합니다.",
        422,
      );
    if (!d.original) {
      const current = await this.rest(c, "GET", this.path(c));
      if (
        (current.config ?? {}).ingress?.some((r: any) => r.hostname === domain)
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "이미 존재하는 Tunnel 도메인을 덮어쓰지 않습니다.",
          409,
        );
      d.original = current.config ?? {
        ingress: [{ service: "http_status:404" }],
      };
      c.save();
    }
    return [
      {
        type: "CNAME",
        name: domain,
        value: a.tunnelId + ".cfargotunnel.com",
        purpose: "routing",
        note: "Cloudflare DNS에서 프록시(주황색 구름)를 켜세요.",
      },
    ] as DnsRecord[];
  }
  async certificateReady(c: Context) {
    const a = c.job.config as any;
    // Cloudflare proxied DNS masks its underlying CNAME; verify the actual record via read-only API.
    const records = await this.rest(
      c,
      "GET",
      "/zones/" +
        a.zoneId +
        "/dns_records?type=CNAME&name=" +
        encodeURIComponent(c.job.result.domain),
    );
    if (
      !records.some(
        (r: any) => r.content === a.tunnelId + ".cfargotunnel.com" && r.proxied,
      )
    )
      throw new HttpsError(
        "DNS_PENDING",
        "프록시된 Tunnel CNAME 등록을 기다립니다.",
        202,
      );
    const packs = await this.rest(
      c,
      "GET",
      "/zones/" + a.zoneId + "/ssl/certificate_packs",
    );
    return packs.some(
      (p: any) =>
        p.status === "active" &&
        p.hosts?.some(
          (h: string) =>
            h === c.job.result.domain ||
            h === "*." + c.job.result.domain.split(".").slice(1).join("."),
        ),
    );
  }
  async apply(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      domain = c.job.result.domain;
    const current = await this.rest(c, "GET", this.path(c)),
      config = current.config ?? { ingress: [{ service: "http_status:404" }] };
    if (
      config.ingress?.some(
        (r: any) =>
          r.hostname === domain &&
          (!d.routeIntent || r.service !== a.originUrl),
      )
    )
      throw new HttpsError(
        "RESOURCE_CONFLICT",
        "다른 Tunnel 경로와 충돌합니다.",
        409,
      );
    d.routeIntent = true;
    c.save();
    const rules = (config.ingress ?? []).filter(
      (r: any) => r.hostname !== domain,
    );
    const index = rules.findIndex((r: any) => !r.hostname);
    rules.splice(index < 0 ? rules.length : index, 0, {
      hostname: domain,
      service: a.originUrl,
    });
    if (!rules.some((r: any) => !r.hostname))
      rules.push({ service: "http_status:404" });
    await this.rest(c, "PUT", this.path(c), {
      config: { ...config, ingress: rules },
    });
  }
  async redirect(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      base = "/zones/" + a.zoneId;
    let set: any;
    try {
      set = await this.rest(
        c,
        "GET",
        base + "/rulesets/phases/http_request_dynamic_redirect/entrypoint",
      );
    } catch (e) {
      if (!(e instanceof HttpsError) || e.code !== "PROVIDER_HTTP_404") throw e;
      set = await this.rest(c, "POST", base + "/rulesets", {
        name: "Shakedown HTTPS",
        kind: "zone",
        phase: "http_request_dynamic_redirect",
        rules: [],
      });
    }
    d.ruleSetId = set.id;
    c.save();
    const found = set.rules?.find(
      (r: any) => r.ref === c.job.result.binding_id,
    );
    if (found) {
      d.ruleId = found.id;
      c.save();
      return;
    }
    d.redirectIntent = true;
    c.save();
    const result = await this.rest(
      c,
      "POST",
      base + "/rulesets/" + set.id + "/rules",
      {
        ref: c.job.result.binding_id,
        description: "Shakedown HTTPS " + c.job.result.binding_id,
        expression: '(http.host eq "' + c.job.result.domain + '" and not ssl)',
        action: "redirect",
        action_parameters: {
          from_value: {
            target_url: {
              expression:
                'concat("https://' +
                c.job.result.domain +
                '", http.request.uri.path)',
            },
            status_code: 301,
            preserve_query_string: true,
          },
        },
      },
    );
    d.ruleId = result.rules.find(
      (r: any) => r.ref === c.job.result.binding_id,
    ).id;
    c.save();
  }
  async rollback(c: Context) {
    const a = c.job.config as any,
      d = c.job.data;
    if (d.ruleSetId) {
      const set = await this.rest(
        c,
        "GET",
        "/zones/" + a.zoneId + "/rulesets/" + d.ruleSetId,
      );
      const owned = set.rules?.find(
        (r: any) => r.ref === c.job.result.binding_id,
      );
      if (owned)
        await this.rest(
          c,
          "DELETE",
          "/zones/" +
            a.zoneId +
            "/rulesets/" +
            d.ruleSetId +
            "/rules/" +
            owned.id,
        );
      delete d.ruleId;
      d.redirectIntent = false;
      c.save();
    }
    if (d.routeIntent) {
      const current = await this.rest(c, "GET", this.path(c));
      const own = current.config.ingress?.find(
        (r: any) => r.hostname === c.job.result.domain,
      );
      if (own && own.service !== a.originUrl)
        throw new HttpsError(
          "ROLLBACK_CONFLICT",
          "Tunnel 경로가 외부에서 변경되어 자동 복원을 중단합니다.",
          409,
        );
      await this.rest(c, "PUT", this.path(c), {
        config: {
          ...current.config,
          ingress: current.config.ingress.filter(
            (r: any) => r.hostname !== c.job.result.domain,
          ),
        },
      });
      d.routeIntent = false;
      c.save();
    }
  }
}
export class CaddyProvider implements Provider {
  constructor(private io: IO) {}
  rest(c: Context, method: string, path: string, body?: unknown) {
    return this.io.http(
      (c.job.config as any).adminUrl.replace(/\/$/, "") + path,
      method,
      body,
    );
  }
  async prepare(c: Context) {
    const a = c.job.config as any,
      d = c.job.data;
    if (!d.original) {
      const config = await this.rest(c, "GET", "/config/");
      // A dedicated Caddy instance avoids touching unrelated apps and certificate policies.
      if (
        Object.keys(config.apps ?? {}).length ||
        Object.keys(config).some(
          (k) => !["admin", "storage", "apps"].includes(k),
        ) ||
        (config.storage && config.storage.module !== "file_system")
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "앱이 없는 전용 Caddy 인스턴스가 필요합니다.",
          409,
        );
      d.original = config;
      c.save();
    }
    return [
      {
        type: "A",
        name: c.job.result.domain,
        value: a.publicIp,
        purpose: "routing",
      },
    ] as DnsRecord[];
  }
  config(c: Context, redirect = false) {
    const a = c.job.config as any,
      domain = c.job.result.domain,
      u = new URL(a.originUrl);
    if (u.protocol !== "http:" || u.pathname !== "/" || u.search || u.username)
      throw new HttpsError(
        "INVALID_ORIGIN",
        "Caddy origin은 등록된 HTTP origin이어야 합니다.",
      );
    const route = {
      match: [{ host: [domain] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: u.hostname + ":" + (u.port || "80") }],
        },
      ],
    };
    return {
      ...c.job.data.original,
      apps: {
        tls: {
          automation: {
            policies: [
              {
                subjects: [domain],
                issuers: [{ module: "acme", email: a.email }],
              },
            ],
          },
        },
        http: {
          servers: {
            shakedown_https: {
              listen: [":443"],
              routes: [route],
              automatic_https: { disable_redirects: true },
            },
            ...(redirect
              ? {
                  shakedown_redirect: {
                    listen: [":80"],
                    routes: [
                      {
                        match: [{ host: [domain] }],
                        handle: [
                          {
                            handler: "static_response",
                            status_code: 301,
                            headers: {
                              Location: [
                                "https://" + domain + "{http.request.uri}",
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                }
              : {}),
          },
        },
      },
    };
  }
  async load(c: Context, body: unknown) {
    const current = await this.rest(c, "GET", "/config/");
    if (
      !isDeepStrictEqual(current, c.job.data.lastConfig ?? c.job.data.original)
    )
      throw new HttpsError(
        "RESOURCE_CONFLICT",
        "Caddy 설정이 외부에서 변경됐습니다.",
        409,
      );
    c.job.data.lastConfig = body;
    c.job.data.loadIntent = true;
    c.save();
    await this.rest(c, "POST", "/load", body);
  }
  async certificateReady(c: Context) {
    // Caddy's ACME worker starts only after configuration is loaded; public TLS probe decides readiness.
    if (!c.job.data.loaded) {
      await this.load(c, this.config(c));
      c.job.data.loaded = true;
      c.save();
    }
    return true;
  }
  async apply(_c: Context) {}
  async redirect(c: Context) {
    c.job.data.redirectIntent = true;
    c.save();
    await this.load(c, this.config(c, true));
  }
  async rollback(c: Context) {
    if (c.job.data.loadIntent) {
      const current = await this.rest(c, "GET", "/config/");
      if (!isDeepStrictEqual(current, c.job.data.original)) {
        if (!isDeepStrictEqual(current, c.job.data.lastConfig))
          throw new HttpsError(
            "ROLLBACK_CONFLICT",
            "외부에서 변경된 Caddy 설정은 덮어쓰지 않습니다.",
            409,
          );
        await this.rest(c, "POST", "/load", c.job.data.original);
      }
      delete c.job.data.lastConfig;
      c.job.data.loaded = false;
      c.job.data.loadIntent = false;
      c.job.data.redirectIntent = false;
      c.save();
    }
  }
}
