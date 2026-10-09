import type { Context, Provider, DnsRecord } from "../model.js";
import { HttpsError } from "../model.js";
import { gcp, type IO } from "../io.js";
export class GcpProvider implements Provider {
  constructor(private io: IO) {}
  async rest(c: Context, method: string, path: string, body?: unknown) {
    const token = await gcp(this.io, c.job.config, [
      "config",
      "config-helper",
      "--force-auth-refresh",
    ]);
    if (
      token.configuration?.properties?.core?.account !==
      (c.job.config as any).account
    )
      throw new HttpsError(
        "ACCOUNT_MISMATCH",
        "GCP 자격증명 계정이 변경됐습니다.",
      );
    if (!token.credential?.access_token)
      throw new HttpsError(
        "CREDENTIAL_REQUIRED",
        "GCP 전용 구성에 로그인이 필요합니다.",
        422,
      );
    return this.io.http("https://" + path, method, body, {
      Authorization: "Bearer " + token.credential.access_token,
    });
  }
  paths(c: Context) {
    const a = c.job.config as any,
      n = "sd-" + c.job.result.binding_id.slice(4, 24);
    return {
      n,
      cm:
        "certificatemanager.googleapis.com/v1/projects/" +
        a.project +
        "/locations/global",
      compute:
        "compute.googleapis.com/compute/v1/projects/" + a.project + "/global",
    };
  }
  async ensure(
    c: Context,
    key: string,
    get: string,
    post: string,
    body: unknown,
  ) {
    const d = c.job.data;
    try {
      const resource = await this.rest(c, "GET", get),
        expected = body as any;
      if (
        (expected.description &&
          resource.description !== expected.description) ||
        (expected.labels &&
          resource.labels?.shakedown_https !== expected.labels.shakedown_https)
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "기존 GCP 리소스 소유자가 다릅니다.",
          409,
        );
      return resource;
    } catch (e) {
      if (!(e instanceof HttpsError) || e.code !== "PROVIDER_HTTP_404") throw e;
    }
    d[key + "Intent"] = true;
    c.save();
    try {
      await this.rest(c, "POST", post, body);
    } catch (e) {
      if (!(e instanceof HttpsError) || e.code !== "PROVIDER_HTTP_409") throw e;
    }
    throw new HttpsError(
      "RESOURCE_PROPAGATING",
      "GCP 리소스 생성을 기다리고 있습니다.",
      202,
    );
  }
  async prepare(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      { n, cm, compute } = this.paths(c);
    const accounts = await gcp(this.io, a, [
      "auth",
      "list",
      "--filter=status:ACTIVE",
    ]);
    if (!accounts.some((x: any) => x.account === a.account))
      throw new HttpsError(
        "ACCOUNT_MISMATCH",
        "등록된 GCP 전용 계정과 다릅니다.",
      );
    const map = await this.rest(c, "GET", compute + "/urlMaps/" + a.urlMap);
    const proxy = await this.rest(
      c,
      "GET",
      compute + "/targetHttpProxies/" + a.httpProxy,
    );
    if (proxy.urlMap !== map.selfLink)
      throw new HttpsError(
        "RESOURCE_MISMATCH",
        "HTTP 프록시와 URL map 연결이 다릅니다.",
      );
    const forwarding = await this.rest(c, "GET", compute + "/forwardingRules");
    if (
      !forwarding.items?.some(
        (r: any) =>
          r.loadBalancingScheme === "EXTERNAL_MANAGED" &&
          r.IPAddress === a.address &&
          r.target?.endsWith("/targetHttpProxies/" + a.httpProxy),
      )
    )
      throw new HttpsError(
        "RESOURCE_REQUIRED",
        "기존 로드밸런서 IP와 HTTP 프록시 연결이 필요합니다.",
        422,
      );
    if (!d.originalUrlMap) {
      d.originalUrlMap = proxy.urlMap;
      d.map = map.selfLink;
      c.save();
    }
    await this.ensure(
      c,
      "authorization",
      cm + "/dnsAuthorizations/" + n,
      cm + "/dnsAuthorizations?dnsAuthorizationId=" + n,
      {
        domain: c.job.result.domain,
        type: "PER_PROJECT_RECORD",
        description: c.job.result.binding_id,
      },
    );
    const auth = await this.rest(c, "GET", cm + "/dnsAuthorizations/" + n);
    if (
      auth.domain !== c.job.result.domain ||
      auth.description !== c.job.result.binding_id
    )
      throw new HttpsError(
        "RESOURCE_CONFLICT",
        "GCP DNS 인증 리소스 충돌",
        409,
      );
    await this.ensure(
      c,
      "certificate",
      cm + "/certificates/" + n,
      cm + "/certificates?certificateId=" + n,
      {
        managed: {
          domains: [c.job.result.domain],
          dnsAuthorizations: [auth.name],
        },
        labels: { shakedown_https: c.job.result.binding_id },
      },
    );
    const dns: DnsRecord[] = [
      {
        type: "A",
        name: c.job.result.domain,
        value: a.address,
        purpose: "routing",
      },
      {
        type: "CNAME",
        name: auth.dnsResourceRecord.name,
        value: auth.dnsResourceRecord.data,
        purpose: "ownership",
        note: "자동 갱신을 위해 유지하세요.",
      },
    ];
    return dns;
  }
  async certificateReady(c: Context) {
    const { n, cm } = this.paths(c),
      cert = await this.rest(c, "GET", cm + "/certificates/" + n);
    if (cert.managed?.state === "FAILED")
      throw new HttpsError("CERTIFICATE_FAILED", "GCP 인증서 발급 실패", 422);
    return cert.managed?.state === "ACTIVE";
  }
  async apply(c: Context) {
    const a = c.job.config as any,
      { n, cm, compute } = this.paths(c),
      base = "projects/" + a.project + "/locations/global";
    await this.ensure(
      c,
      "certMap",
      cm + "/certificateMaps/" + n,
      cm + "/certificateMaps?certificateMapId=" + n,
      { labels: { shakedown_https: c.job.result.binding_id } },
    );
    await this.ensure(
      c,
      "entry",
      cm + "/certificateMaps/" + n + "/certificateMapEntries/" + n,
      cm +
        "/certificateMaps/" +
        n +
        "/certificateMapEntries?certificateMapEntryId=" +
        n,
      {
        hostname: c.job.result.domain,
        certificates: [base + "/certificates/" + n],
        labels: { shakedown_https: c.job.result.binding_id },
      },
    );
    await this.ensure(
      c,
      "sslPolicy",
      compute + "/sslPolicies/" + n,
      compute + "/sslPolicies",
      {
        name: n,
        profile: "MODERN",
        minTlsVersion: "TLS_1_2",
        description: c.job.result.binding_id,
      },
    );
    await this.ensure(
      c,
      "httpsProxy",
      compute + "/targetHttpsProxies/" + n,
      compute + "/targetHttpsProxies",
      {
        name: n,
        urlMap: c.job.data.map,
        certificateMap:
          "//certificatemanager.googleapis.com/" +
          base +
          "/certificateMaps/" +
          n,
        sslPolicy:
          "https://" +
          compute.replace("compute.googleapis.com", "www.googleapis.com") +
          "/sslPolicies/" +
          n,
        description: c.job.result.binding_id,
      },
    );
    await this.ensure(
      c,
      "forwarding",
      compute + "/forwardingRules/" + n,
      compute + "/forwardingRules",
      {
        name: n,
        IPAddress: a.address,
        IPProtocol: "TCP",
        portRange: "443",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        target:
          "https://" +
          compute.replace("compute.googleapis.com", "www.googleapis.com") +
          "/targetHttpsProxies/" +
          n,
        description: c.job.result.binding_id,
      },
    );
  }
  async redirect(c: Context) {
    const a = c.job.config as any,
      { n, compute } = this.paths(c);
    await this.ensure(
      c,
      "redirectMap",
      compute + "/urlMaps/" + n,
      compute + "/urlMaps",
      {
        name: n,
        description: c.job.result.binding_id,
        defaultUrlRedirect: {
          httpsRedirect: true,
          hostRedirect: c.job.result.domain,
          redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
          stripQuery: false,
        },
      },
    );
    c.job.data.redirectIntent = true;
    c.save();
    await this.rest(
      c,
      "POST",
      compute + "/targetHttpProxies/" + a.httpProxy + "/setUrlMap",
      {
        urlMap:
          "https://" +
          compute.replace("compute.googleapis.com", "www.googleapis.com") +
          "/urlMaps/" +
          n,
      },
    );
  }
  async rollback(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      { n, compute } = this.paths(c);
    if (d.redirectIntent) {
      const proxy = await this.rest(
        c,
        "GET",
        compute + "/targetHttpProxies/" + a.httpProxy,
      );
      if (
        proxy.urlMap !== d.originalUrlMap &&
        proxy.urlMap !==
          "https://" +
            compute.replace("compute.googleapis.com", "www.googleapis.com") +
            "/urlMaps/" +
            n
      )
        throw new HttpsError(
          "ROLLBACK_CONFLICT",
          "HTTP 프록시가 외부에서 변경됐습니다.",
          409,
        );
      if (proxy.urlMap !== d.originalUrlMap) {
        await this.rest(
          c,
          "POST",
          compute + "/targetHttpProxies/" + a.httpProxy + "/setUrlMap",
          { urlMap: d.originalUrlMap },
        );
        throw new HttpsError(
          "ROLLBACK_PENDING",
          "HTTP 경로 복원을 기다리고 있습니다.",
          202,
        );
      }
      d.redirectIntent = false;
      c.save();
    }
    // Deletions are asynchronous: keep rollback_pending and retry until dependencies have disappeared.
    for (const [key, path] of [
      ["forwarding", "forwardingRules"],
      ["httpsProxy", "targetHttpsProxies"],
      ["redirectMap", "urlMaps"],
      ["sslPolicy", "sslPolicies"],
    ]) {
      if (!d[key + "Intent"]) continue;
      try {
        const resource = await this.rest(
          c,
          "GET",
          compute + "/" + path + "/" + n,
        );
        if (resource.description !== c.job.result.binding_id)
          throw new HttpsError(
            "ROLLBACK_CONFLICT",
            "다른 GCP 리소스는 삭제하지 않습니다.",
            409,
          );
        await this.rest(c, "DELETE", compute + "/" + path + "/" + n);
        throw new HttpsError(
          "ROLLBACK_PENDING",
          "GCP 삭제 완료를 기다리고 있습니다.",
          202,
        );
      } catch (e) {
        if (e instanceof HttpsError && e.code === "PROVIDER_HTTP_404") {
          d[key + "Intent"] = false;
          c.save();
        } else throw e;
      }
    }
  }
}
