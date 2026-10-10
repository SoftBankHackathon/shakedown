import type { Context, Provider, DnsRecord } from "../model.js";
import { HttpsError } from "../model.js";
import { az, type IO } from "../io.js";
export class AzureProvider implements Provider {
  constructor(private io: IO) {}
  cli(c: Context, args: string[]) {
    return az(this.io, c.job.config, args);
  }
  resource(c: Context) {
    const a = c.job.config as any;
    return (
      "/subscriptions/" +
      a.subscriptionId +
      "/resourceGroups/" +
      a.resourceGroup +
      "/providers/" +
      (a.kind === "azure-container-apps"
        ? "Microsoft.App/containerApps/"
        : "Microsoft.Web/sites/") +
      a.name
    );
  }
  async rest(c: Context, method: string, path: string, body?: unknown) {
    const a = c.job.config as any,
      version = a.kind === "azure-container-apps" ? "2024-03-01" : "2023-12-01";
    const token = await this.cli(c, [
      "account",
      "get-access-token",
      "--resource",
      "https://management.azure.com/",
    ]);
    if (
      token.subscription !== a.subscriptionId ||
      token.tenant !== a.tenantId ||
      !token.accessToken
    )
      throw new HttpsError(
        "ACCOUNT_MISMATCH",
        "Azure 자격증명이 등록된 구독·테넌트와 다릅니다.",
      );
    return this.io.http(
      "https://management.azure.com" + path + "?api-version=" + version,
      method,
      body,
      { Authorization: "Bearer " + token.accessToken },
    );
  }
  async prepare(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      name = c.job.result.domain;
    const account = await this.cli(c, ["account", "show"]);
    if (
      account.id !== a.subscriptionId ||
      account.tenantId !== a.tenantId ||
      account.state !== "Enabled"
    )
      throw new HttpsError(
        "ACCOUNT_MISMATCH",
        "Azure 구독·테넌트를 확인하세요.",
      );
    const app = await this.rest(c, "GET", this.resource(c));
    const aca = a.kind === "azure-container-apps",
      ingress = app.properties.configuration?.ingress;
    if (aca && (!ingress || !ingress.external))
      throw new HttpsError(
        "RESOURCE_REQUIRED",
        "공개 Container Apps Ingress가 필요합니다.",
        422,
      );
    const host = aca ? ingress.fqdn : app.properties.defaultHostName;
    if (new URL(a.originUrl).hostname !== host)
      throw new HttpsError(
        "RESOURCE_MISMATCH",
        "등록된 Azure 기본 주소와 실제 리소스가 다릅니다.",
      );
    if (!d.original) {
      d.original = aca
        ? {
            customDomains: ingress.customDomains ?? [],
            allowInsecure: ingress.allowInsecure ?? false,
          }
        : { httpsOnly: app.properties.httpsOnly };
      const names = aca
        ? (ingress.customDomains ?? [])
        : (
            await this.rest(c, "GET", this.resource(c) + "/hostNameBindings")
          ).value.map((v: any) => ({ name: v.name.split("/").pop() }));
      if (names.some((v: any) => v.name === name))
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "이미 연결된 사용자 도메인을 덮어쓰지 않습니다.",
          409,
        );
      if (!aca) {
        const plan = await this.rest(c, "GET", app.properties.serverFarmId);
        if (["Free", "Shared"].includes(plan.sku?.tier))
          throw new HttpsError(
            "RESOURCE_REQUIRED",
            "App Service 관리형 인증서를 지원하는 요금제가 필요합니다.",
            422,
          );
      }
      d.host = host;
      d.location = app.location;
      d.verification = aca
        ? app.properties.customDomainVerificationId
        : app.properties.customDomainVerificationId;
      if (
        aca &&
        (
          app.properties.environmentId ?? app.properties.managedEnvironmentId
        )?.toLowerCase() !==
          (
            "/subscriptions/" +
            a.subscriptionId +
            "/resourceGroups/" +
            a.resourceGroup +
            "/providers/Microsoft.App/managedEnvironments/" +
            a.environment
          ).toLowerCase()
      )
        throw new HttpsError(
          "RESOURCE_MISMATCH",
          "Container Apps 환경이 일치하지 않습니다.",
        );
      c.save();
    }
    const records: DnsRecord[] = [
      {
        type: "CNAME",
        name,
        value: d.host,
        purpose: "routing",
        note: "프록시 없이 서비스 기본 도메인을 직접 가리켜야 합니다.",
      },
    ];
    if (d.verification)
      records.push({
        type: "TXT",
        name: "asuid." + name,
        value: d.verification,
        purpose: "ownership",
      });
    return records;
  }
  async certificateReady(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      name = c.job.result.domain,
      base = this.resource(c);
    const certName = "shakedown-" + c.job.result.binding_id.slice(4, 24);
    if (a.kind === "azure-container-apps") {
      const cert =
        "/subscriptions/" +
        a.subscriptionId +
        "/resourceGroups/" +
        a.resourceGroup +
        "/providers/Microsoft.App/managedEnvironments/" +
        a.environment +
        "/managedCertificates/" +
        certName;
      if (!d.domainAdded) {
        const current = await this.rest(c, "GET", base),
          ingress = current.properties.configuration.ingress;
        const domains = ingress.customDomains ?? [];
        if (domains.some((v: any) => v.name === name) && !d.domainIntent)
          throw new HttpsError(
            "RESOURCE_CONFLICT",
            "DNS 대기 중 다른 도메인 바인딩이 등록됐습니다.",
            409,
          );
        d.domainIntent = true;
        c.save();
        if (!domains.some((v: any) => v.name === name))
          await this.rest(c, "PATCH", base, {
            properties: {
              configuration: {
                ingress: {
                  ...ingress,
                  customDomains: [
                    ...domains,
                    { name, bindingType: "Disabled" },
                  ],
                },
              },
            },
          });
        d.domainAdded = true;
        c.save();
      }
      if (!d.certRequested) {
        d.certificateId = cert;
        c.save();
        await this.rest(c, "PUT", cert, {
          location: d.location,
          properties: { subjectName: name, domainControlValidation: "CNAME" },
        });
        d.certRequested = true;
        c.save();
      }
      let result: any;
      try {
        result = await this.rest(c, "GET", cert);
      } catch (e) {
        if (e instanceof HttpsError && e.code === "PROVIDER_HTTP_404")
          return false;
        throw e;
      }
      if (result.properties.provisioningState === "Failed")
        throw new HttpsError(
          "CERTIFICATE_FAILED",
          "Azure 인증서 발급 실패: CNAME·CAA·앱 실행 상태를 확인하세요.",
          422,
        );
      return result.properties.provisioningState === "Succeeded";
    }
    const binding = base + "/hostNameBindings/" + name;
    if (!d.domainAdded) {
      const existing = (await this.rest(c, "GET", base + "/hostNameBindings"))
        .value;
      if (
        existing.some((b: any) => b.name.endsWith("/" + name)) &&
        !d.domainIntent
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "기존 도메인 바인딩이 변경됐습니다.",
          409,
        );
      d.domainIntent = true;
      c.save();
      await this.rest(c, "PUT", binding, {
        properties: {
          siteName: a.name,
          hostNameType: "Verified",
          customHostNameDnsRecordType: "CName",
        },
      });
      d.domainAdded = true;
      c.save();
    }
    const cert =
      "/subscriptions/" +
      a.subscriptionId +
      "/resourceGroups/" +
      a.resourceGroup +
      "/providers/Microsoft.Web/certificates/" +
      certName;
    if (!d.certRequested) {
      const app = await this.rest(c, "GET", base);
      d.certificateId = cert;
      c.save();
      await this.rest(c, "PUT", cert, {
        location: a.location,
        properties: {
          canonicalName: name,
          serverFarmId: app.properties.serverFarmId,
        },
      });
      d.certRequested = true;
      c.save();
    }
    let result: any;
    try {
      result = await this.rest(c, "GET", cert);
    } catch (e) {
      if (e instanceof HttpsError && e.code === "PROVIDER_HTTP_404")
        return false;
      throw e;
    }
    if (result.properties.thumbprint) {
      d.thumbprint = result.properties.thumbprint;
      c.save();
      return true;
    }
    return false;
  }
  async apply(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      name = c.job.result.domain,
      base = this.resource(c);
    if (a.kind === "azure-container-apps") {
      const current = await this.rest(c, "GET", base),
        ingress = current.properties.configuration.ingress;
      await this.rest(c, "PATCH", base, {
        properties: {
          configuration: {
            ingress: {
              ...ingress,
              customDomains: (ingress.customDomains ?? []).map((v: any) =>
                v.name === name
                  ? {
                      name,
                      certificateId: d.certificateId,
                      bindingType: "SniEnabled",
                    }
                  : v,
              ),
            },
          },
        },
      });
    } else
      await this.rest(c, "PUT", base + "/hostNameBindings/" + name, {
        properties: {
          siteName: a.name,
          sslState: "SniEnabled",
          thumbprint: d.thumbprint,
          hostNameType: "Verified",
        },
      });
  }
  async redirect(c: Context) {
    c.job.data.redirectIntent = true;
    c.save();
    const a = c.job.config as any,
      base = this.resource(c);
    if (a.kind === "azure-container-apps") {
      const app = await this.rest(c, "GET", base);
      await this.rest(c, "PATCH", base, {
        properties: {
          configuration: {
            ingress: {
              ...app.properties.configuration.ingress,
              allowInsecure: false,
            },
          },
        },
      });
    } else
      await this.rest(c, "PATCH", base, { properties: { httpsOnly: true } });
  }
  async rollback(c: Context) {
    const a = c.job.config as any,
      d = c.job.data,
      base = this.resource(c);
    if (!d.domainIntent) return;
    if (a.kind === "azure-container-apps") {
      const app = await this.rest(c, "GET", base),
        ingress = app.properties.configuration.ingress;
      const currentBinding = ingress?.customDomains?.find(
        (x: any) => x.name === c.job.result.domain,
      );
      if (
        currentBinding?.certificateId &&
        currentBinding.certificateId !== d.certificateId
      )
        throw new HttpsError(
          "ROLLBACK_CONFLICT",
          "도메인이 다른 인증서에 연결되어 자동 삭제를 중단합니다.",
          409,
        );
      if (!ingress)
        throw new HttpsError(
          "ROLLBACK_CONFLICT",
          "Ingress가 외부에서 변경됐습니다.",
          409,
        );
      await this.rest(c, "PATCH", base, {
        properties: {
          configuration: {
            ingress: {
              ...ingress,
              customDomains: (ingress.customDomains ?? []).filter(
                (v: any) => v.name !== c.job.result.domain,
              ),
              ...(d.redirectIntent
                ? { allowInsecure: d.original.allowInsecure }
                : {}),
            },
          },
        },
      });
    } else {
      const bindings = await this.rest(c, "GET", base + "/hostNameBindings");
      if (
        bindings.value.some((b: any) =>
          b.name.endsWith("/" + c.job.result.domain),
        )
      )
        await this.rest(
          c,
          "DELETE",
          base + "/hostNameBindings/" + c.job.result.domain,
        );
      if (d.redirectIntent)
        await this.rest(c, "PATCH", base, {
          properties: { httpsOnly: d.original.httpsOnly },
        });
    }
    d.domainAdded = false;
    d.domainIntent = false;
    d.redirectIntent = false;
    c.save();
  }
}
