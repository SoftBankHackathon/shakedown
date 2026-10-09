import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Manager } from "../src/manager.js";
import { createApp } from "../src/app.js";
import {
  settingsSchema,
  domainSchema,
  HttpsError,
  type Provider,
  type Context,
} from "../src/model.js";
import { verify, isPublic, dnsCheck } from "../src/probe.js";

const settings = settingsSchema.parse({
  endpoints: [
    {
      projectId: "project",
      target: "local",
      kind: "caddy",
      originUrl: "http://127.0.0.1:18080",
      adminUrl: "http://127.0.0.1:2019",
      publicIp: "8.8.8.8",
      email: "demo@example.com",
    },
  ],
});
const okProbe = async (url: string) =>
  url.startsWith("https:")
    ? { status: 200, expires_at: "2099-01-01T00:00:00Z", issuer: "Test CA" }
    : { status: 301, location: url.replace("http:", "https:") };
function fixture(path = ":memory:") {
  let now = Date.now(),
    dns = true,
    certificate = true,
    fail = false,
    rollbackFail = false;
  const calls: string[] = [];
  const provider: Provider = {
    prepare: async () => {
      calls.push("prepare");
      return [
        {
          type: "A",
          name: "app.example.com",
          value: "8.8.8.8",
          purpose: "routing",
        },
      ];
    },
    certificateReady: async () => certificate,
    apply: async () => {
      calls.push("apply");
      if (fail) throw new Error("SECRET_SHOULD_NOT_LEAK");
    },
    redirect: async () => {
      calls.push("redirect");
    },
    rollback: async () => {
      calls.push("rollback");
      if (rollbackFail) throw new Error("secret");
    },
  };
  const store = new Store(path);
  const manager = new Manager(
    settings,
    store,
    () => provider,
    async () => [{ name: "dns", ok: dns, detail: "test" }],
    okProbe,
    () => now,
  );
  return {
    manager,
    store,
    provider,
    calls,
    set now(v: number) {
      now = v;
    },
    get now() {
      return now;
    },
    set dns(v: boolean) {
      dns = v;
    },
    set certificate(v: boolean) {
      certificate = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    set rollbackFail(v: boolean) {
      rollbackFail = v;
    },
  };
}
test("DNS wait, certificate wait, verify-before-redirect and ready metadata", async () => {
  const f = fixture();
  f.dns = false;
  const a = f.manager.create("project", "local", {
    domain: "App.Example.COM.",
    local_mode: "caddy",
  });
  assert.equal(a.domain, "app.example.com");
  await f.manager.run("project", "local");
  assert.equal(f.manager.get("project", "local")?.status, "dns_pending");
  f.dns = true;
  f.certificate = false;
  await f.manager.run("project", "local");
  assert.equal(
    f.manager.get("project", "local")?.status,
    "certificate_pending",
  );
  f.certificate = true;
  await f.manager.run("project", "local");
  const b = f.manager.get("project", "local")!;
  assert.equal(b.status, "ready");
  assert.equal(b.https_url, "https://app.example.com");
  assert.ok(b.certificate?.expires_at);
  assert.deepEqual(f.calls, ["prepare", "apply", "redirect"]);
  assert.equal(b.internal_transport, "unverified");
  f.store.close();
});
test("identical requests reuse binding; domain/config changes and cross-project reuse conflict", () => {
  const f = fixture();
  const b = { domain: "app.example.com", local_mode: "caddy" };
  assert.equal(
    f.manager.create("project", "local", b).binding_id,
    f.manager.create("project", "local", b).binding_id,
  );
  assert.throws(
    () =>
      f.manager.create("project", "local", {
        ...b,
        domain: "other.example.com",
      }),
    /다른 도메인/,
  );
  assert.throws(
    () =>
      f.store.create(
        { ...settings.endpoints[0], projectId: "other" },
        "app.example.com",
      ),
    /다른 대상/,
  );
  f.store.close();
});
test("restart resumes persisted certificate wait without applying twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "https-state-")),
    path = join(dir, "state.sqlite");
  const f = fixture(path);
  try {
    f.certificate = false;
    const first = f.manager.create("project", "local", {
      domain: "app.example.com",
      local_mode: "caddy",
    });
    await f.manager.run("project", "local");
    f.store.close();
    const next = fixture(path);
    await next.manager.run("project", "local");
    assert.equal(
      next.manager.get("project", "local")?.binding_id,
      first.binding_id,
    );
    assert.deepEqual(next.calls, ["apply", "redirect"]);
    next.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("24h limit requires explicit recheck and recovery retains identity", async () => {
  const f = fixture();
  f.dns = false;
  f.manager.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  f.now += 86_400_001;
  await f.manager.run("project", "local");
  assert.equal(f.manager.get("project", "local")?.status, "needs_action");
  assert.ok(f.calls.includes("rollback"));
  f.manager.recheck("project", "local");
  f.dns = true;
  await f.manager.run("project", "local");
  assert.equal(f.manager.get("project", "local")?.status, "ready");
  f.store.close();
});
test("provider failure redacts raw error and retry only starts after rollback", async () => {
  const f = fixture();
  f.fail = true;
  f.rollbackFail = true;
  f.manager.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  await f.manager.run("project", "local");
  assert.equal(
    f.manager.get("project", "local")?.error?.code,
    "ROLLBACK_PENDING",
  );
  assert.throws(() => f.manager.recheck("project", "local"), /복원/);
  assert.ok(
    !JSON.stringify(f.manager.get("project", "local")).includes("SECRET"),
  );
  f.rollbackFail = false;
  await f.manager.run("project", "local");
  f.fail = false;
  f.manager.recheck("project", "local");
  await f.manager.run("project", "local");
  assert.equal(f.manager.get("project", "local")?.status, "ready");
  f.store.close();
});
test("concurrent start/run is serialized per binding", async () => {
  const f = fixture();
  let release!: () => void;
  f.provider.prepare = async () => {
    await new Promise<void>((r) => (release = r));
    return [];
  };
  f.manager.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  const first = f.manager.run("project", "local");
  await f.manager.run("project", "local");
  assert.throws(() => f.manager.recheck("project", "local"), /검사 중/);
  release();
  await first;
  assert.equal(f.calls.filter((x) => x === "apply").length, 1);
  f.store.close();
});
test("ready certificate failure preserves HTTPS instead of restoring HTTP", async () => {
  const f = fixture();
  f.manager.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  await f.manager.run("project", "local");
  const m = new Manager(
    settings,
    f.store,
    () => f.provider,
    undefined,
    async () => {
      throw Error("expired");
    },
  );
  await m.run("project", "local");
  assert.equal(m.get("project", "local")?.status, "needs_action");
  assert.ok(!f.calls.includes("rollback"));
  assert.equal(m.get("project", "local")?.https_url, "https://app.example.com");
  f.store.close();
});
test("bad redirect is retried for propagation then rolled back", async () => {
  const f = fixture();
  let now = Date.now();
  const m = new Manager(
    settings,
    f.store,
    () => f.provider,
    async () => [],
    async (url) =>
      url.startsWith("https:")
        ? okProbe(url)
        : { status: 301, location: "https://evil.example.com/" },
    () => now,
  );
  m.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  await m.run("project", "local");
  assert.equal(m.get("project", "local")?.status, "verifying");
  now += 120_001;
  await m.run("project", "local");
  assert.equal(m.get("project", "local")?.status, "failed");
  assert.ok(f.calls.includes("rollback"));
  f.store.close();
});
test("public API excludes settings, tokens, provider journals and guards browser origins", async () => {
  const f = fixture(),
    app = createApp(f.manager),
    base = "/projects/project/targets/local/https";
  const headers = { host: "127.0.0.1:9301" };
  try {
    const r = await app.inject({
      method: "POST",
      url: base,
      headers,
      payload: { domain: "app.example.com", local_mode: "caddy" },
    });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().config, undefined);
    assert.equal(r.json().data, undefined);
    assert.equal(
      (await app.inject({ url: base, headers: { host: "evil.example.com" } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: base,
          headers: { ...headers, origin: "http://localhost:3700" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: { domain: "app.example.com", token: "SECRET" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/projects/project/targets/gcp/https",
          headers,
          payload: { domain: "gcp.example.com" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: base + "/recheck", headers }))
        .statusCode,
      202,
    );
  } finally {
    await app.close();
    f.store.close();
  }
});
test("reject apex, wildcard, URL, localhost, private suffix and invalid labels", () => {
  for (const d of [
    "example.com",
    "*.example.com",
    "https://app.example.com",
    "app.localhost",
    "127.0.0.1",
    "app.blogspot.com",
    "a..example.com",
    "-a.example.com",
  ])
    assert.equal(domainSchema.safeParse(d).success, false, d);
  assert.equal(domainSchema.parse("app.example.co.kr"), "app.example.co.kr");
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "192.0.2.1",
  ])
    assert.equal(isPublic(ip), false, ip);
  assert.equal(isPublic("8.8.8.8"), true);
});
test("DNS resolver errors become actionable wait, split TXT values concatenate", async () => {
  const resolver: any = {
    resolveCname: async () => {
      throw Error("NXDOMAIN");
    },
    resolveTxt: async () => [["ab", "cd"]],
  };
  const results = await dnsCheck(
    [
      {
        type: "CNAME",
        name: "a.example.com",
        value: "b.example.com",
        purpose: "routing",
      },
      {
        type: "TXT",
        name: "asuid.a.example.com",
        value: "abcd",
        purpose: "ownership",
      },
    ],
    resolver,
  );
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
});
test("expired certificate and wrong redirect can never pass verification", async () => {
  const f = fixture(),
    b = f.manager.create("project", "local", {
      domain: "app.example.com",
      local_mode: "caddy",
    });
  await assert.rejects(
    verify(b, "/", false, async () => ({
      status: 200,
      expires_at: "2000-01-01",
    })),
    /유효기간/,
  );
  await assert.rejects(
    verify(b, "/", true, async (u) =>
      u.startsWith("https")
        ? okProbe(u)
        : { status: 302, location: "https://app.example.com/" },
    ),
    /쿼리/,
  );
  f.store.close();
});
test("AWS gate refuses pending setup, recovers desired close and confirms both protocols", async () => {
  const f = fixture();
  const cfg: any = { ...settings.endpoints[0], target: "aws" };
  const j = f.store.create(cfg, "app.example.com");
  j.data.everReady = true;
  j.result.status = "ready";
  j.result.https_url = "https://app.example.com";
  f.store.save(j);
  let open = false;
  f.provider.gate = async (_c, o) => {
    open = o;
  };
  const m = new Manager(
    { ...settings, endpoints: [cfg] },
    f.store,
    () => f.provider,
    undefined,
    async (u) => ({
      status: open ? (u.startsWith("https") ? 200 : 301) : 403,
      location: "https://app.example.com/",
    }),
  );
  assert.deepEqual(await m.gate("project", false), {
    configured: true,
    url: "https://app.example.com",
    blocked: true,
  });
  assert.equal(f.store.get("project", "aws")?.data.gatePending, false);
  await m.gate("project", true);
  assert.equal(open, true);
  f.store.close();
});

test("SQLite process lock rejects a second live process owner and releases atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "https-lock-")),
    path = join(dir, "state.sqlite");
  const a = new Store(path),
    b = new Store(path);
  try {
    a.acquire("first");
    assert.throws(() => b.acquire("second"), /이미 실행/);
    b.release("not-owner");
    assert.throws(() => b.acquire("second"), /이미 실행/);
    a.release("first");
    b.acquire("second");
    b.release("second");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("changed operator resources suspend jobs before any cloud operation", async () => {
  const f = fixture();
  f.manager.create("project", "local", {
    domain: "app.example.com",
    local_mode: "caddy",
  });
  const m = new Manager(
    { ...settings, endpoints: [] },
    f.store,
    () => f.provider,
  );
  await m.run("project", "local");
  assert.equal(m.get("project", "local")?.error?.code, "CONFIG_CHANGED");
  assert.equal(f.calls.length, 0);
  f.store.close();
});
test("failed AWS gate opening is recovered closed without deleting HTTPS or reopening HTTP", async () => {
  const cfg = settingsSchema.parse({
    endpoints: [
      {
        projectId: "project",
        target: "aws",
        kind: "aws-alb",
        originUrl: "http://demo.elb.amazonaws.com",
        profile: "hackathon",
        accountId: "123456789012",
        region: "ap-northeast-2",
        loadBalancerArn: "arn:aws:lb",
        listenerArn: "arn:aws:listener",
        targetGroupArn: "arn:aws:target",
        securityGroupId: "sg-test",
      },
    ],
  });
  const store = new Store(":memory:"),
    j = store.create(cfg.endpoints[0], "app.example.com");
  j.result.status = "ready";
  j.result.https_url = "https://app.example.com";
  j.data.everReady = true;
  store.save(j);
  const f = fixture(),
    gates: boolean[] = [];
  let closed = false;
  f.provider.gate = async (_c, open) => {
    gates.push(open);
    if (open) throw Error("connection lost");
    closed = true;
  };
  const m = new Manager(
    cfg,
    store,
    () => f.provider,
    undefined,
    async () => ({ status: closed ? 403 : 500 }),
  );
  await assert.rejects(m.gate("project", true));
  await m.run("project", "aws");
  assert.deepEqual(gates, [true, false]);
  assert.equal(store.get("project", "aws")?.result.traffic_blocked, true);
  assert.ok(!f.calls.includes("rollback"));
  store.close();
  f.store.close();
});

test("AWS stop during pending setup rolls back partial HTTPS before allowing target cleanup", async () => {
  const f = fixture();
  const cfg: any = { ...settings.endpoints[0], target: "aws" };
  f.store.create(cfg, "app.example.com");
  const m = new Manager(
    { ...settings, endpoints: [cfg] },
    f.store,
    () => f.provider,
  );
  await assert.rejects(m.gate("project", true), /HTTPS 설정/);
  f.rollbackFail = true;
  await assert.rejects(m.gate("project", false));
  assert.equal(f.store.get("project", "aws")?.rollbackPending, true);
  f.rollbackFail = false;
  await m.run("project", "aws");
  assert.equal(f.store.get("project", "aws")?.rollbackPending, false);
  assert.equal(f.store.get("project", "aws")?.result.status, "needs_action");
  assert.equal(f.calls.filter((x) => x === "rollback").length, 2);
  assert.deepEqual(await m.gate("project", false), { configured: false });
  f.store.close();
});
