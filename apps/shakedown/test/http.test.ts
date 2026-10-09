import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession } from "../src/http.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("리다이렉트를 따라가며 모든 hop을 기록하고 POST 뒤에는 GET으로 바꾼다", async () => {
  const url = await serve((req, res) => {
    if (req.url === "/login") {
      res.writeHead(302, { location: "/board" }).end();
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(`<p>${req.method} board</p>`);
    }
  });
  const page = await createSession(url).request("POST", "/login", { email: "a@b.c" });
  assert.deepEqual(page.hops, [
    { method: "POST", path: "/login", status: 302, instance: null },
    { method: "GET", path: "/board", status: 200, instance: null },
  ]);
  assert.equal(page.finalPath, "/board");
  assert.equal(page.finalStatus, 200);
  assert.match(page.html, /GET board/);
});

test("302 응답의 Set-Cookie를 보관해서 다음 요청에 보낸다", async () => {
  const url = await serve((req, res) => {
    if (req.url === "/login") {
      res.writeHead(302, { location: "/me", "set-cookie": "JSESSIONID=abc; Path=/; HttpOnly" }).end();
    } else {
      res.writeHead(200).end(`cookie=${req.headers.cookie ?? ""}`);
    }
  });
  const session = createSession(url);
  const page = await session.request("POST", "/login", {});
  assert.equal(page.html, "cookie=JSESSIONID=abc");
  assert.equal(session.lastHtml(), "cookie=JSESSIONID=abc");
});

test("폼 값은 urlencoded로 보낸다", async () => {
  const url = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200).end(`${req.headers["content-type"]}|${body}`));
  });
  const page = await createSession(url).request("POST", "/join", { email: "a@b.c", nickname: "sd 1" });
  assert.equal(page.html, "application/x-www-form-urlencoded;charset=UTF-8|email=a%40b.c&nickname=sd+1");
});

test("다른 호스트로 리다이렉트돼도 대상 사이트 안에서 따라간다", async () => {
  const url = await serve((req, res) => {
    if (req.url === "/write") res.writeHead(302, { location: "http://localhost:8080/" }).end();
    else res.writeHead(200).end("home");
  });
  const page = await createSession(url).request("GET", "/write");
  assert.equal(page.finalPath, "/");
  assert.equal(page.html, "home");
});

test("응답이 시간 제한을 넘기면 오류를 낸다", async () => {
  const url = await serve(() => {
    /* 응답하지 않음 */
  });
  await assert.rejects(createSession(url, { timeoutMs: 100 }).request("GET", "/"), { name: "TimeoutError" });
});

test("307·308 리다이렉트는 메서드와 본문을 그대로 유지한다", async () => {
  const url = await serve((req, res) => {
    if (req.url === "/old") return void res.writeHead(307, { location: "/new" }).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200).end(`${req.method} ${req.url} ${body}`));
  });
  const page = await createSession(url).request("POST", "/old", { title: "t" });
  assert.equal(page.html, "POST /new title=t");
  assert.deepEqual(page.hops.map((h) => h.method), ["POST", "POST"]);
});

test("만료된 쿠키(Max-Age=0, 지난 Expires)는 더 보내지 않는다", async () => {
  const url = await serve((req, res) => {
    if (req.url === "/in") return void res.writeHead(302, { location: "/me", "set-cookie": ["JSESSIONID=abc", "theme=dark"] }).end();
    if (req.url === "/out") {
      return void res
        .writeHead(302, { location: "/me", "set-cookie": ["JSESSIONID=deleted; Max-Age=0", "theme=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT"] })
        .end();
    }
    res.writeHead(200).end(`cookie=${req.headers.cookie ?? ""}`);
  });
  const session = createSession(url);
  assert.equal((await session.request("GET", "/in")).html, "cookie=JSESSIONID=abc; theme=dark");
  assert.equal((await session.request("GET", "/out")).html, "cookie=");
});

test("records the instance header at each redirect hop", async () => {
  const url = await serve((req,res) => req.url === "/login"
    ? res.writeHead(302, {location:"/board", "x-instance-id":"instance-a"}).end()
    : res.writeHead(200, {"x-instance-id":"instance-b"}).end("board"));
  const page = await createSession(url).request("POST", "/login", {});
  assert.deepEqual(page.hops.map(h => h.instance), ["instance-a", "instance-b"]);
});

test("cancelling a session prevents following redirects or issuing later writes", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  const url = await serve((req,res) => {
    paths.push(req.url!);
    controller.abort();
    res.writeHead(302, {location:"/next"}).end();
  });
  const session = createSession(url, {signal:controller.signal});
  await assert.rejects(session.request("GET", "/"));
  await assert.rejects(session.request("POST", "/write", {title:"must not write"}));
  assert.deepEqual(paths, ["/"]);
});

// Cloudflare 엣지가 앱에 넘기기 전에 직접 만든 530. 본문은 읽지 않는다(앱이 요청을 받은 적이 없다).
const edge530 = (res: ServerResponse) =>
  res.writeHead(530, { server: "cloudflare", "content-type": "text/html" }).end("<title>Cloudflare Tunnel error</title> Error 1033");

test("Cloudflare 530(터널 미준비)은 다시 보내고, 앱 응답만 hop으로 남긴다", async () => {
  let hits = 0;
  const url = await serve((_, res) => (++hits <= 2 ? edge530(res) : res.writeHead(200).end("join")));
  const page = await createSession(url, { tunnelIntervalMs: 50 }).request("GET", "/join");
  assert.equal(hits, 3);
  assert.equal(page.finalStatus, 200);
  assert.equal(page.html, "join");
  assert.deepEqual(page.hops, [{ method: "GET", path: "/join", status: 200, instance: null }]);
});

test("POST도 530이면 같은 본문으로 다시 보낸다(엣지가 앱에 넘기지 않았으므로)", async () => {
  const bodies: string[] = [];
  let hits = 0;
  const url = await serve((req, res) => {
    if (++hits === 1) return void edge530(res);
    if (req.url !== "/login") return void res.writeHead(200).end("board");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(302, { location: "/board" }).end();
    });
  });
  const page = await createSession(url, { tunnelIntervalMs: 50 }).request("POST", "/login", { email: "a@b.c" });
  assert.deepEqual(bodies, ["email=a%40b.c"]);
  assert.deepEqual(page.hops.map((h) => `${h.method} ${h.path} ${h.status}`), ["POST /login 302", "GET /board 200"]);
});

test("530이 그치지 않으면 정해진 시간 뒤 530 그대로 돌려준다", async () => {
  let hits = 0;
  const url = await serve((_, res) => (hits++, edge530(res)));
  const started = Date.now();
  const page = await createSession(url, { tunnelWaitMs: 300, tunnelIntervalMs: 50 }).request("GET", "/");
  assert.equal(page.finalStatus, 530);
  assert.ok(hits > 1);
  assert.ok(Date.now() - started < 1_000);
});

test("530 대기 시간은 리다이렉트를 포함한 요청 하나에 한 번만 준다", async () => {
  // 경로마다 처음 3번은 530이라 50ms 간격이면 hop마다 약 150ms를 기다린다.
  // hop마다 350ms를 새로 주면 /b까지 가서 200이 되지만, 요청 하나(= 단계 하나)에 350ms만 주면
  // hop 셋에 필요한 450ms를 다 기다리지 못하고 530으로 끝나야 한다.
  // 연결을 매번 닫는다. 쉬었다가 keep-alive 연결을 다시 쓰면 macOS 루프백에서 요청이 수백 ms 늦게 도착해 시간 계산이 흔들린다.
  const close = { connection: "close" };
  const seen = new Map<string, number>();
  const url = await serve((req, res) => {
    const n = (seen.get(req.url!) ?? 0) + 1;
    seen.set(req.url!, n);
    if (n <= 3) return void res.writeHead(530, { ...close, server: "cloudflare" }).end("Error 1033");
    if (req.url === "/login") return void res.writeHead(302, { ...close, location: "/a" }).end();
    if (req.url === "/a") return void res.writeHead(302, { ...close, location: "/b" }).end();
    res.writeHead(200, close).end("b");
  });
  const page = await createSession(url, { tunnelWaitMs: 350, tunnelIntervalMs: 50 }).request("POST", "/login", { email: "a@b.c" });
  assert.equal(page.finalStatus, 530);
});

test("로그인 뒤 530이 나서 다시 보낼 때도 쿠키를 그대로 보낸다", async () => {
  // 쿠키가 빠진 채 다시 보내면 앱이 로그인 화면으로 돌려보내서, 터널이 잠깐 흔들린 것이 가짜 BLOCKED가 된다.
  const boardCookies: (string | undefined)[] = [];
  let boardHits = 0;
  const url = await serve((req, res) => {
    if (req.url === "/login") return void res.writeHead(302, { location: "/board", "set-cookie": "JSESSIONID=abc; Path=/" }).end();
    if (++boardHits === 2) return void edge530(res);
    boardCookies.push(req.headers.cookie);
    res.writeHead(200).end("board");
  });
  const session = createSession(url, { tunnelIntervalMs: 50 });
  await session.request("POST", "/login", { email: "a@b.c" });
  const page = await session.request("GET", "/board");
  assert.equal(page.finalStatus, 200);
  assert.equal(boardHits, 3);
  assert.deepEqual(boardCookies, ["JSESSIONID=abc", "JSESSIONID=abc"]);
});

test("앱이 낸 응답(server: cloudflare 500, server 헤더 없는 530)은 다시 보내지 않는다", async () => {
  for (const [status, headers] of [[500, { server: "cloudflare" }], [530, {}]] as const) {
    let hits = 0;
    const url = await serve((_, res) => (hits++, res.writeHead(status, headers).end("app")));
    const page = await createSession(url, { tunnelIntervalMs: 50 }).request("GET", "/");
    assert.equal(page.finalStatus, status);
    assert.equal(hits, 1);
  }
});

test("530을 기다리는 중에 취소되면 기다림을 바로 멈추고 더 보내지 않는다", async () => {
  // 530 응답을 받은 뒤 2초 간격 대기에 들어간 다음(100ms)에 취소한다. 응답 전에 취소하면 대기 경로를 시험하지 못한다.
  const controller = new AbortController();
  let hits = 0;
  const url = await serve((_, res) => (hits++, edge530(res)));
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(createSession(url, { signal: controller.signal, tunnelIntervalMs: 2_000 }).request("GET", "/"), { name: "AbortError" });
  assert.ok(Date.now() - started < 1_000, "취소 뒤에도 대기 간격(2초)을 끝까지 기다렸다");
  assert.equal(hits, 1);
});
