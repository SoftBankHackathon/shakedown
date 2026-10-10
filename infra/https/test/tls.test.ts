import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createProber } from "../src/probe.js";

test("real TLS handshake checks trusted chain and SAN; unknown CA and wrong host fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shakedown-tls-"));
  const cmd = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    cmd(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-days",
      "1",
      "-subj",
      "/CN=Shakedown Test CA",
    );
    cmd(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
      "-subj",
      "/CN=app.example.com",
    );
    writeFileSync(
      join(dir, "ext"),
      "subjectAltName=DNS:app.example.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
    );
    cmd(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "leaf.crt",
      "-days",
      "1",
      "-extfile",
      "ext",
    );
    const ca = readFileSync(join(dir, "ca.crt"));
    server = createServer(
      {
        key: readFileSync(join(dir, "leaf.key")),
        cert: readFileSync(join(dir, "leaf.crt")),
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    // Only the test transport routes to a local fixture. Production DNS still rejects loopback.
    const resolve: any = async () => [{ address: "8.8.8.8", family: 4 }];
    const transport = (trusted: boolean) =>
      ((url: URL, opts: any, cb: any) => {
        const dest = new URL(url);
        dest.port = String(port);
        return request(
          dest,
          {
            ...opts,
            ...(trusted ? { ca } : {}),
            lookup: (_h: any, o: any, done: any) =>
              o.all
                ? done(null, [{ address: "127.0.0.1", family: 4 }])
                : done(null, "127.0.0.1", 4),
          },
          cb,
        );
      }) as typeof request;
    const trusted = createProber(resolve, transport(true));
    assert.equal((await trusted("https://app.example.com/")).status, 200);
    await assert.rejects(trusted("https://wrong.example.com/"), /인증서/);
    await assert.rejects(
      createProber(resolve, transport(false))("https://app.example.com/"),
      /인증서/,
    );
    await assert.rejects(
      createProber((async () => [{ address: "127.0.0.1", family: 4 }]) as any)(
        "https://app.example.com/",
      ),
      /비공개/,
    );
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
