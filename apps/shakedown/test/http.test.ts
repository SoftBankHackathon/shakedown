import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
