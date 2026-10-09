import { test } from "node:test";
import assert from "node:assert/strict";
import { AwsProvider } from "../src/providers/aws.js";
import { AzureProvider } from "../src/providers/azure.js";
import { GcpProvider } from "../src/providers/gcp.js";
import { CloudflareProvider, CaddyProvider } from "../src/providers/local.js";
import { endpointSchema, HttpsError, type Context } from "../src/model.js";
import { Store } from "../src/store.js";
import type { IO } from "../src/io.js";

function context(config: any) {
  const store = new Store(":memory:");
  const job = store.create(endpointSchema.parse(config), "app.example.com");
  return { store, c: { job, save: () => store.save(job) } as Context };
}
const common = {
  projectId: "project",
  healthPath: "/",
  originUrl: "http://demo.elb.amazonaws.com",
};
const awsConfig = {
  ...common,
  target: "aws",
  kind: "aws-alb",
  profile: "hackathon",
  accountId: "123456789012",
  region: "ap-northeast-2",
  loadBalancerArn:
    "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:loadbalancer/app/demo/1",
  listenerArn:
    "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:listener/app/demo/1/80",
  targetGroupArn:
    "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:targetgroup/demo/1",
  securityGroupId: "sg-demo",
};
const forward = [{ Type: "forward", TargetGroupArn: awsConfig.targetGroupArn }];
function awsFake(c: Context) {
  const calls: { service: string; operation: string; args: string[] }[] = [];
  const listeners: any[] = [
    {
      ListenerArn: awsConfig.listenerArn,
      Port: 80,
      Protocol: "HTTP",
      DefaultActions: forward,
    },
  ];
  const sg: any[] = [];
  let ruleActions = forward;
  const io: IO = {
    http: async () => {
      throw Error("unexpected");
    },
    command: async (_tool, args) => {
      const [service, operation] = args;
      calls.push({ service, operation, args });
      assert.equal(args[args.indexOf("--profile") + 1], "hackathon");
      switch (operation) {
        case "get-caller-identity":
          return { Account: "123456789012" };
        case "describe-load-balancers":
          return {
            LoadBalancers: [
              {
                Scheme: "internet-facing",
                SecurityGroups: ["sg-demo"],
                DNSName: "demo.elb.amazonaws.com",
              },
            ],
          };
        case "describe-listeners":
          return { Listeners: listeners };
        case "describe-rules":
          return {
            Rules: [
              {
                IsDefault: !("gateRuleArn" in c.job.config),
                RuleArn: (c.job.config as any).gateRuleArn,
                Actions: ruleActions,
              },
            ],
          };
        case "describe-tags":
          return {
            TagDescriptions: [
              {
                Tags: [
                  { Key: "ShakedownHttps", Value: c.job.result.binding_id },
                ],
              },
            ],
          };
        case "request-certificate":
          return { CertificateArn: "cert" };
        case "describe-certificate":
          return {
            Certificate: {
              Status: "ISSUED",
              DomainValidationOptions: [
                {
                  ResourceRecord: {
                    Name: "_auth.app.example.com",
                    Value: "_auth.acm-validations.aws.",
                  },
                },
              ],
            },
          };
        case "describe-security-group-rules":
          return { SecurityGroupRules: sg };
        case "authorize-security-group-ingress":
          sg.push({
            SecurityGroupRuleId: "sgr-own",
            Description: c.job.result.binding_id,
            CidrIpv4: "0.0.0.0/0",
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
          });
          return { SecurityGroupRules: sg };
        case "create-listener":
          listeners.push({
            ListenerArn: "listener443",
            Port: 443,
            DefaultActions: JSON.parse(
              args[args.indexOf("--default-actions") + 1],
            ),
          });
          return { Listeners: [listeners[1]] };
        case "modify-listener": {
          const l = listeners.find(
            (l) => l.ListenerArn === args[args.indexOf("--listener-arn") + 1],
          );
          l.DefaultActions = JSON.parse(
            args[args.indexOf("--default-actions") + 1],
          );
          return {};
        }
        case "modify-rule":
          ruleActions = JSON.parse(args[args.indexOf("--actions") + 1]);
          return {};
        case "delete-listener":
          listeners.splice(1, 1);
          return {};
        case "revoke-security-group-ingress":
          sg.splice(0);
          return {};
        default:
          throw Error(operation);
      }
    },
  };
  return {
    io,
    calls,
    listeners,
    sg,
    get ruleActions() {
      return ruleActions;
    },
  };
}
for (const mode of ["listener", "rule"])
  test(
    "AWS " +
      mode +
      " gate:443 close/open, redirect, owned rollback and preserved certificate",
    async () => {
      const { store, c } = context({
        ...awsConfig,
        ...(mode === "rule"
          ? {
              gateRuleArn: awsConfig.listenerArn.replace(
                "listener/",
                "listener-rule/",
              ),
            }
          : {}),
      });
      try {
        const f = awsFake(c),
          p = new AwsProvider(f.io);
        assert.equal((await p.prepare(c)).length, 2);
        assert.equal(await p.certificateReady(c), true);
        await p.apply(c);
        assert.equal(f.listeners[1].DefaultActions[0].Type, "forward");
        await p.redirect(c);
        assert.equal(f.listeners[0].DefaultActions[0].Type, "redirect");
        await p.gate(c, false);
        assert.equal(
          f.listeners[1].DefaultActions[0].FixedResponseConfig.StatusCode,
          "403",
        );
        await p.gate(c, true);
        assert.equal(f.listeners[1].DefaultActions[0].Type, "forward");
        if (mode === "rule") assert.equal(f.ruleActions[0].Type, "redirect");
        await p.rollback(c);
        assert.equal(f.listeners.length, 1);
        assert.equal(f.sg.length, 0);
        assert.equal(f.listeners[0].DefaultActions[0].Type, "forward");
        assert.equal(c.job.data.certificateArn, "cert");
        assert.ok(!f.calls.some((c) => c.operation === "delete-certificate"));
      } finally {
        store.close();
      }
    },
  );
test("AWS refuses wrong account before mutation and never replaces unrelated 443", async () => {
  const { store, c } = context(awsConfig),
    f = awsFake(c);
  const wrong: IO = {
    ...f.io,
    command: async () => ({ Account: "000000000000" }),
  };
  await assert.rejects(new AwsProvider(wrong).prepare(c), /전용 계정/);
  f.listeners.push({ Port: 443, ListenerArn: "foreign" });
  await assert.rejects(new AwsProvider(f.io).prepare(c), /덮어쓰지/);
  assert.ok(!f.calls.some((x) => x.operation === "request-certificate"));
  store.close();
});
test("AWS recovery discovers tagged listener and SG after response was lost", async () => {
  const { store, c } = context(awsConfig),
    f = awsFake(c),
    p = new AwsProvider(f.io);
  await p.prepare(c);
  await p.apply(c);
  delete c.job.data.httpsListener;
  delete c.job.data.sgRuleId;
  await p.rollback(c);
  assert.equal(f.listeners.length, 1);
  assert.equal(f.sg.length, 0);
  store.close();
});

const azureBase = {
  projectId: "project",
  target: "azure",
  subscriptionId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceGroup: "hackathon",
  name: "board",
};
for (const kind of ["azure-container-apps", "azure-app-service"])
  test(
    kind + " issues/binds certificate and restores only its hostname",
    async () => {
      const aca = kind === "azure-container-apps",
        host = aca ? "demo.azurecontainerapps.io" : "demo.azurewebsites.net";
      const cfg = {
        ...azureBase,
        kind,
        originUrl: "https://" + host,
        ...(aca ? { environment: "env" } : { location: "koreacentral" }),
      };
      const { store, c } = context(cfg);
      const base =
        "/subscriptions/" +
        cfg.subscriptionId +
        "/resourceGroups/hackathon/providers/";
      let app: any = {
        location: "koreacentral",
        properties: {
          environmentId: base + "Microsoft.App/managedEnvironments/env",
          customDomainVerificationId: "verification",
          defaultHostName: host,
          serverFarmId: base + "Microsoft.Web/serverfarms/plan",
          httpsOnly: false,
          configuration: {
            ingress: {
              fqdn: host,
              external: true,
              allowInsecure: true,
              customDomains: [{ name: "other.example.com" }],
            },
          },
        },
      };
      const bindings: any[] = [{ name: "board/other.example.com" }];
      const calls: any[] = [];
      const io: IO = {
        command: async (_t, args) =>
          args[0] === "account" && args[1] === "show"
            ? {
                id: cfg.subscriptionId,
                tenantId: cfg.tenantId,
                state: "Enabled",
              }
            : {
                subscription: cfg.subscriptionId,
                tenant: cfg.tenantId,
                accessToken: "DO_NOT_SAVE",
              },
        http: async (url, method = "GET", body: any, headers) => {
          assert.equal(headers?.Authorization, "Bearer DO_NOT_SAVE");
          const path = new URL(url).pathname;
          calls.push({ path, method, body });
          if (path.includes("/serverfarms/")) return { sku: { tier: "Basic" } };
          if (path.endsWith("/hostNameBindings")) return { value: bindings };
          if (path.includes("/hostNameBindings/")) {
            if (method === "PUT")
              bindings.push({
                name: "board/app.example.com",
                properties: body.properties,
              });
            if (method === "DELETE")
              for (let i = bindings.length - 1; i >= 0; i--)
                if (bindings[i].name === "board/app.example.com")
                  bindings.splice(i, 1);
            return {};
          }
          if (
            path.includes("/managedCertificates/") ||
            path.includes("/certificates/")
          )
            return {
              properties: { provisioningState: "Succeeded", thumbprint: "ABC" },
            };
          if (method === "PATCH") {
            app.properties = { ...app.properties, ...body.properties };
          }
          return structuredClone(app);
        },
      };
      const p = new AzureProvider(io);
      try {
        const dns = await p.prepare(c);
        assert.equal(dns[1].name, "asuid.app.example.com");
        assert.equal(await p.certificateReady(c), true);
        await p.apply(c);
        await p.redirect(c);
        assert.equal(
          aca
            ? app.properties.configuration.ingress.allowInsecure
            : app.properties.httpsOnly,
          aca ? false : true,
        );
        await p.rollback(c);
        assert.equal(
          aca
            ? app.properties.configuration.ingress.allowInsecure
            : app.properties.httpsOnly,
          aca ? true : false,
        );
        assert.ok(
          (aca
            ? app.properties.configuration.ingress.customDomains
            : bindings
          ).some((x: any) => x.name.endsWith("other.example.com")),
        );
        assert.ok(!JSON.stringify(c.job).includes("DO_NOT_SAVE"));
        assert.ok(
          !calls.some(
            (x) => x.method === "DELETE" && x.path.includes("certificates"),
          ),
        );
      } finally {
        store.close();
      }
    },
  );

test("GCP uses existing external ALB, durable async resources, exact redirect and owned rollback", async () => {
  const cfg = {
    projectId: "project",
    target: "gcp",
    kind: "gcp-alb",
    originUrl: "http://8.8.8.8",
    project: "demo-project",
    configuration: "hackathon",
    account: "demo@example.com",
    urlMap: "existing-map",
    httpProxy: "existing-http",
    address: "8.8.8.8",
  };
  const { store, c } = context(cfg),
    resources = new Map<string, any>(),
    pfx =
      "https://compute.googleapis.com/compute/v1/projects/demo-project/global";
  resources.set(pfx + "/urlMaps/existing-map", {
    selfLink:
      "https://www.googleapis.com/compute/v1/projects/demo-project/global/urlMaps/existing-map",
  });
  resources.set(pfx + "/targetHttpProxies/existing-http", {
    urlMap: resources.get(pfx + "/urlMaps/existing-map").selfLink,
  });
  resources.set(pfx + "/forwardingRules", {
    items: [
      {
        IPAddress: "8.8.8.8",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        target: pfx + "/targetHttpProxies/existing-http",
      },
    ],
  });
  const io: IO = {
    command: async (_t, args) =>
      args[0] === "auth"
        ? [{ account: "demo@example.com" }]
        : {
            configuration: {
              properties: { core: { account: "demo@example.com" } },
            },
            credential: { access_token: "PRIVATE_TOKEN" },
          },
    http: async (url, method = "GET", body: any) => {
      if (method === "GET") {
        if (!resources.has(url))
          throw new HttpsError("PROVIDER_HTTP_404", "missing", 404);
        return structuredClone(resources.get(url));
      }
      if (method === "DELETE") {
        resources.delete(url);
        return {};
      }
      if (url.endsWith("/setUrlMap")) {
        resources.get(url.replace("/setUrlMap", "")).urlMap = body.urlMap;
        return {};
      }
      const u = new URL(url),
        id = [...u.searchParams.values()][0] ?? body.name;
      u.search = "";
      const dest = u.toString() + "/" + id;
      resources.set(dest, {
        ...body,
        name: "projects/demo-project/locations/global/dnsAuthorizations/" + id,
        ...(url.includes("/dnsAuthorizations?")
          ? {
              dnsResourceRecord: {
                name: "_auth.app.example.com",
                data: "auth.example.net",
              },
            }
          : {}),
        ...(body.managed
          ? { managed: { ...body.managed, state: "ACTIVE" } }
          : {}),
      });
      return {};
    },
  };
  const p = new GcpProvider(io);
  const complete = async (fn: () => Promise<unknown>) => {
    for (let i = 0; i < 12; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof HttpsError) || e.statusCode !== 202) throw e;
      }
    }
    throw Error("never finished");
  };
  try {
    await complete(() => p.prepare(c));
    assert.equal(await p.certificateReady(c), true);
    await complete(() => p.apply(c));
    await complete(() => p.redirect(c));
    const redirect = [...resources.values()].find((r) => r.defaultUrlRedirect);
    assert.equal(redirect.defaultUrlRedirect.stripQuery, false);
    assert.equal(redirect.defaultUrlRedirect.hostRedirect, "app.example.com");
    for (const r of resources.values())
      if (r.sslPolicy) assert.ok(r.sslPolicy.startsWith("https://"));
    await complete(() => p.rollback(c));
    assert.equal(
      resources.get(pfx + "/targetHttpProxies/existing-http").urlMap,
      c.job.data.originalUrlMap,
    );
    assert.ok([...resources.keys()].some((k) => k.includes("/certificates/")));
    assert.ok(!JSON.stringify(c.job).includes("PRIVATE_TOKEN"));
  } finally {
    store.close();
  }
});

test("Cloudflare preserves unrelated ingress and redirect rules and never writes DNS", async () => {
  const { store, c } = context({
    projectId: "project",
    target: "local",
    kind: "cloudflare-tunnel",
    originUrl: "http://localhost:8080",
    accountId: "a".repeat(32),
    zoneId: "b".repeat(32),
    tunnelId: "11111111-1111-4111-8111-111111111111",
    tokenEnv: "HTTPS_TEST_TOKEN",
  });
  process.env.HTTPS_TEST_TOKEN = "PRIVATE_CF";
  let config: any = {
      ingress: [
        { hostname: "other.example.com", service: "http://other:80" },
        { service: "http_status:404" },
      ],
    },
    rules: any[] = [{ id: "other", ref: "other" }];
  const calls: any[] = [];
  const io: IO = {
    command: async () => {},
    http: async (url, method = "GET", body: any) => {
      const path = new URL(url).pathname;
      calls.push({ path, method });
      let result: any;
      if (path.endsWith("/zones/" + "b".repeat(32)))
        result = {
          account: { id: "a".repeat(32) },
          name: "example.com",
          status: "active",
        };
      else if (path.includes("/dns_records"))
        result = [
          {
            content: (c.job.config as any).tunnelId + ".cfargotunnel.com",
            proxied: true,
          },
        ];
      else if (path.includes("/certificate_packs"))
        result = [{ status: "active", hosts: ["*.example.com"] }];
      else if (path.endsWith("/configurations")) {
        if (method === "PUT") config = body.config;
        result = { config: structuredClone(config) };
      } else if (path.includes("/cfd_tunnel/"))
        result = { config_src: "cloudflare" };
      else if (method === "POST") {
        rules.push({ ...body, id: "own" });
        result = { rules };
      } else if (method === "DELETE") {
        rules = rules.filter((r) => r.id !== "own");
        result = {};
      } else result = { id: "ruleset", rules };
      return { success: true, result };
    },
  };
  const p = new CloudflareProvider(io);
  try {
    await p.prepare(c);
    assert.equal(await p.certificateReady(c), true);
    await p.apply(c);
    await p.redirect(c);
    assert.equal(config.ingress[1].hostname, "app.example.com");
    assert.equal(
      rules[1].action_parameters.from_value.preserve_query_string,
      true,
    );
    await p.rollback(c);
    assert.equal(config.ingress[0].hostname, "other.example.com");
    assert.deepEqual(rules, [{ id: "other", ref: "other" }]);
    assert.ok(
      !calls.some((x) => x.path.includes("/dns_records") && x.method !== "GET"),
    );
    assert.ok(!JSON.stringify(c.job).includes("PRIVATE_CF"));
  } finally {
    delete process.env.HTTPS_TEST_TOKEN;
    store.close();
  }
});
test("Caddy disables automatic redirect until verification and restores dedicated instance configuration", async () => {
  const { store, c } = context({
    projectId: "project",
    target: "local",
    kind: "caddy",
    originUrl: "http://localhost:8080",
    adminUrl: "http://127.0.0.1:2019",
    publicIp: "8.8.8.8",
    email: "demo@example.com",
  });
  let config: any = { admin: { listen: "localhost:2019" } };
  const io: IO = {
    command: async () => {},
    http: async (_url, method = "GET", body) => {
      if (method === "POST") config = structuredClone(body);
      return structuredClone(config);
    },
  };
  const p = new CaddyProvider(io);
  try {
    await p.prepare(c);
    await p.certificateReady(c);
    assert.equal(
      config.apps.http.servers.shakedown_https.automatic_https
        .disable_redirects,
      true,
    );
    assert.equal(config.apps.http.servers.shakedown_redirect, undefined);
    await p.redirect(c);
    assert.equal(
      config.apps.http.servers.shakedown_redirect.routes[0].handle[0].headers
        .Location[0],
      "https://app.example.com{http.request.uri}",
    );
    await p.rollback(c);
    assert.deepEqual(config, { admin: { listen: "localhost:2019" } });
  } finally {
    store.close();
  }
});

test("AWS rollback does not overwrite an externally changed gate rule", async () => {
  const { store, c } = context({
    ...awsConfig,
    gateRuleArn: awsConfig.listenerArn.replace("listener/", "listener-rule/"),
  });
  const f = awsFake(c),
    p = new AwsProvider(f.io);
  try {
    await p.prepare(c);
    await p.apply(c);
    await p.redirect(c);
    const external = [
      { Type: "fixed-response", FixedResponseConfig: { StatusCode: "503" } },
    ];
    await f.io.command("aws", [
      "elbv2",
      "modify-rule",
      "--actions",
      JSON.stringify(external),
      "--profile",
      "hackathon",
    ]);
    await assert.rejects(p.rollback(c), /외부에서 변경/);
    assert.deepEqual(f.ruleActions, external);
    assert.equal(f.listeners.length, 2);
  } finally {
    store.close();
  }
});

test("Caddy rollback refuses an external configuration change", async () => {
  const { store, c } = context({
    projectId: "project",
    target: "local",
    kind: "caddy",
    originUrl: "http://localhost:8080",
    adminUrl: "http://127.0.0.1:2019",
    publicIp: "8.8.8.8",
    email: "demo@example.com",
  });
  let config: any = { admin: { listen: "127.0.0.1:2019" } };
  const p = new CaddyProvider({
    command: async () => {},
    http: async (_u, method = "GET", body) => {
      if (method === "POST") config = structuredClone(body);
      return structuredClone(config);
    },
  });
  try {
    await p.prepare(c);
    await p.certificateReady(c);
    await p.redirect(c);
    config.apps.http.servers.someone_else = { listen: [":8081"] };
    await assert.rejects(p.rollback(c), /외부|변경|충돌/);
    assert.ok(config.apps.http.servers.someone_else);
  } finally {
    store.close();
  }
});
