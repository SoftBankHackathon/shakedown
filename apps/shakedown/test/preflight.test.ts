import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { waitUntilReachable } from "../src/preflight.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

function serve(port = 0): Promise<number> {
  const server = createServer((_, res) => res.writeHead(500).end("boom"));
  servers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("응답이 오면(500이어도) 바로 true", async () => {
  const port = await serve();
  assert.equal(await waitUntilReachable(`http://127.0.0.1:${port}/`), true);
});

test("늦게 뜨는 서버는 기다렸다가 true", async () => {
  const port = await freePort();
  setTimeout(() => void serve(port), 150);
  assert.equal(await waitUntilReachable(`http://127.0.0.1:${port}/`, { waitMs: 2_000, intervalMs: 50 }), true);
});

test("끝까지 안 뜨면 기다린 뒤 false", async () => {
  const port = await freePort();
  const started = Date.now();
  assert.equal(await waitUntilReachable(`http://127.0.0.1:${port}/`, { waitMs: 300, intervalMs: 50 }), false);
  assert.ok(Date.now() - started < 1_000);
});
