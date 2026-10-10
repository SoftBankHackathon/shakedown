import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
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

// 요청마다 몇 번째인지(hit) 넘겨주는 서버. 몇 번 다시 시도했는지 센다.
function serveWith(handler: (hit: number, res: ServerResponse) => void): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_, res) => handler(++hits, res));
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits: () => hits })),
  );
}

// 실측한 Cloudflare 엣지 530 모양: server: cloudflare, text/html 오류 페이지(1033·1016).
const edge530 = (res: ServerResponse) =>
  res.writeHead(530, { server: "cloudflare", "content-type": "text/html" }).end("<title>Cloudflare Tunnel error</title> Error 1033");

test("Cloudflare 530(터널 미준비)만 오면 기다린 뒤 false", async () => {
  const s = await serveWith((_, res) => edge530(res));
  assert.equal(await waitUntilReachable(s.url, { waitMs: 300, intervalMs: 50 }), false);
  assert.ok(s.hits() > 1);
});

test("530이 그치고 앱이 응답하면(500이어도) true", async () => {
  const s = await serveWith((hit, res) => (hit <= 2 ? edge530(res) : res.writeHead(500, { server: "cloudflare" }).end("boom")));
  assert.equal(await waitUntilReachable(s.url, { waitMs: 5_000, intervalMs: 50 }), true);
  assert.equal(s.hits(), 3);
});

test("server: cloudflare가 붙은 앱 500은 바로 true", async () => {
  const s = await serveWith((_, res) => res.writeHead(500, { server: "cloudflare" }).end("boom"));
  assert.equal(await waitUntilReachable(s.url, { waitMs: 300, intervalMs: 50 }), true);
  assert.equal(s.hits(), 1);
});

test("530을 기다리는 중에 취소되면 기다림을 바로 멈춘다", async () => {
  // 시운전 마감(150초)에 걸리면 접속 확인도 곧바로 끝나야 한다. 530 응답 뒤 2초 간격 대기에 들어간 다음(100ms)에 취소한다.
  const controller = new AbortController();
  const s = await serveWith((_, res) => edge530(res));
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(waitUntilReachable(s.url, { waitMs: 10_000, intervalMs: 2_000, signal: controller.signal }), { name: "AbortError" });
  assert.ok(Date.now() - started < 1_000, "취소 뒤에도 대기 간격(2초)을 끝까지 기다렸다");
  assert.equal(s.hits(), 1);
});
