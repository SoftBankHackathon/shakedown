/** Opt-in real Caddy test. No public ports, DNS edits, ACME requests, or system trust installation. */
import { createServer as httpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as tcpServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { CaddyProvider } from "../src/providers/local.js";
import { Store } from "../src/store.js";
import { endpointSchema } from "../src/model.js";
import { io } from "../src/io.js";
import { createProber, verify } from "../src/probe.js";
const binary = process.env.CADDY_BINARY;
if (!binary)
  throw Error("Set CADDY_BINARY to a verified official Caddy binary.");
const dir = mkdtempSync(join(tmpdir(), "shakedown-caddy-smoke-"));
async function port() {
  const s = tcpServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const adminPort = await port(),
  tlsPort = await port(),
  httpPort = await port();
const backend = httpServer((_req, res) => {
  res.end("Shakedown fixture");
});
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const original = {
  admin: { listen: "127.0.0.1:" + adminPort },
  storage: { module: "file_system", root: join(dir, "storage") },
};
writeFileSync(join(dir, "boot.json"), JSON.stringify(original));
const child = spawn(binary, ["run", "--config", join(dir, "boot.json")], {
  stdio: "ignore",
});
const store = new Store(":memory:");
const config = endpointSchema.parse({
  projectId: "smoke",
  target: "local",
  kind: "caddy",
  originUrl: "http://127.0.0.1:" + (backend.address() as any).port,
  adminUrl: "http://127.0.0.1:" + adminPort,
  publicIp: "8.8.8.8",
  email: "test@example.com",
});
const job = store.create(config, "app.example.com"),
  ctx = { job, save: () => store.save(job) };
const p = new CaddyProvider({
  ...io,
  http: async (url, method, body: any, headers) => {
    if (body?.apps?.tls) {
      // Check the unmodified production ACME configuration using the real parser first.
      writeFileSync(join(dir, "production.json"), JSON.stringify(body));
      execFileSync(
        binary,
        ["validate", "--config", join(dir, "production.json")],
        {
          stdio: "pipe",
          env: { ...process.env, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
        },
      );
      body = structuredClone(body);
      body.apps.tls.automation.policies[0].issuers = [{ module: "internal" }];
      body.apps.pki = {
        certificate_authorities: { local: { install_trust: false } },
      };
      body.apps.http.http_port = httpPort;
      body.apps.http.https_port = tlsPort;
      body.apps.http.servers.shakedown_https.listen = ["127.0.0.1:" + tlsPort];
      if (body.apps.http.servers.shakedown_redirect)
        body.apps.http.servers.shakedown_redirect.listen = [
          "127.0.0.1:" + httpPort,
        ];
      job.data.lastConfig = body;
      ctx.save(); // Record the test-only transport's transformed configuration.
    }
    return io.http(url, method, body, headers);
  },
});
try {
  for (let n = 0; ; n++) {
    try {
      await fetch(config.kind === "caddy" ? config.adminUrl + "/config/" : "");
      break;
    } catch {
      if (n > 50) throw Error("Caddy startup failed");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await p.prepare(ctx);
  await p.certificateReady(ctx);
  const resolver: any = async () => [{ address: "8.8.8.8", family: 4 }];
  const secure = ((url: URL, opts: any, cb: any) => {
    const u = new URL(url);
    u.port = String(tlsPort);
    return httpsRequest(
      u,
      {
        ...opts,
        ca: readFileSync(join(dir, "storage/pki/authorities/local/root.crt")),
        lookup: (_h: any, o: any, done: any) =>
          o.all
            ? done(null, [{ address: "127.0.0.1", family: 4 }])
            : done(null, "127.0.0.1", 4),
      },
      cb,
    );
  }) as typeof httpsRequest;
  const plain = ((url: URL, opts: any, cb: any) => {
    const u = new URL(url);
    u.port = String(httpPort);
    return httpRequest(
      u,
      {
        ...opts,
        lookup: (_h: any, o: any, done: any) =>
          o.all
            ? done(null, [{ address: "127.0.0.1", family: 4 }])
            : done(null, "127.0.0.1", 4),
      },
      cb,
    );
  }) as typeof httpRequest;
  const probe = createProber(resolver, secure, plain);
  let first: any;
  for (let n = 0; ; n++) {
    try {
      first = await verify(job.result, "/", false, probe);
      break;
    } catch (e) {
      if (n > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(first.certificate.expires_at);
  await p.redirect(ctx);
  // A config reload may close old listeners before replacements accept connections.
  // The real manager also waits for propagation before treating verification as failed.
  let final: Awaited<ReturnType<typeof verify>>;
  for (let n = 0; ; n++) {
    try {
      final = await verify(job.result, "/", true, probe);
      break;
    } catch (e) {
      if (n > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(final.checks.length, 2);
  await p.rollback(ctx);
  const restored = await io.http("http://127.0.0.1:" + adminPort + "/config/");
  assert.ok(!restored.apps || Object.keys(restored.apps).length === 0);
  console.log(
    JSON.stringify(
      {
        caddy: "2.10.2",
        production_config: "valid",
        local_trusted_https: "pass",
        redirect_path_query: "pass",
        rollback: "pass",
        public_acme: "not_tested",
      },
      null,
      2,
    ),
  );
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
  await new Promise<void>((r) => backend.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
