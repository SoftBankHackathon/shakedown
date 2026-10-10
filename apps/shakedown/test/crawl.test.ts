import { test, after } from "node:test";
import assert from "node:assert/strict";
import { crawl, crawlScenario, type CrawledPage } from "../src/crawl.ts";
import { startFakeApp, type FakeAppOptions } from "./fake-app.ts";

const apps: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(apps.map((a) => a.close())));

async function app(options: FakeAppOptions = {}) {
  const a = await startFakeApp(options);
  apps.push(a);
  return a;
}

test("JSON만 주는 앱: \"/\"와 health_path를 열고 화면 글자 앞부분을 남긴다", async () => {
  const a = await app();
  const pages = await crawl(a.url, { healthPath: "/healthz" });
  assert.deepEqual(pages.map((p) => [p.path, p.final_path, p.status]), [["/", "/", 200], ["/healthz", "/healthz", 200]]);
  assert.equal(pages[0].text, `{"language":"node","database":false,"count":null}`);
  assert.deepEqual([pages[0].title, pages[0].links, pages[0].forms, pages[0].error], ["", [], [], null]);
});

test("health_path가 \"/\"로 시작하는 문자열이 아니면 무시한다", async () => {
  for (const healthPath of [undefined, 42, "healthz", "//evil.example/x", "https://evil.example/"]) {
    const a = await app();
    const pages = await crawl(a.url, { healthPath });
    assert.deepEqual(pages.map((p) => p.path), ["/"], String(healthPath));
    assert.deepEqual(a.hits, ["GET /"]);
  }
});

test("같은 출처 링크만 따라가고 로그아웃·삭제·관리자·결제·정적 파일·데이터 주소·다른 출처는 건너뛴다", async () => {
  const a = await app({
    pages: {
      "/": `<title>Shop</title>
        <a href="/products">Products</a><a href="/products">Products again</a>
        <a href="/logout">Log out</a><a href="/items/3/delete">Delete</a><a href="/style.css">css</a>
        <a href="/admin">Admin</a><a href="/checkout">Checkout</a>
        <a href="/items/3">Item 3</a><a href="/post?id=6">Post 6</a><a href="/notes/5f8d0d55b54764421b7156c9">Note</a>
        <a href="/files/123e4567-e89b-12d3-a456-426614174000">File</a>
        <a href="https://other.example/x">Other</a><a href="mailto:a@b.c">Mail</a>
        <a href="#top">Top</a>
        <form action="/search" method="get"><input name="q"></form>
        <form action="/items/3/delete" method="post"></form><form action="/checkout" method="post"></form>`,
      "/products": `<title>Products</title><a href="/about">About</a><a href="/products?page=2">Next</a>`,
    },
  });
  const pages = await crawl(a.url);
  assert.deepEqual(pages.map((p) => p.path), ["/", "/products", "/about"]);
  assert.deepEqual(pages[0].links, [
    { text: "Products", path: "/products" },
    { text: "Top", path: "/" },
  ]);
  // 삭제·결제 폼은 AI에게도 보여 주지 않는다.
  assert.deepEqual(pages[0].forms, [{ action: "/search", method: "GET", inputs: [{ name: "q", type: "text" }] }]);
  assert.equal(pages[1].title, "Products");
  assert.ok(a.hits.every((h) => h.startsWith("GET ")), a.hits.join(", "));
});

test("리다이렉트된 최종 경로는 다시 열지 않고, 페이지는 최대 6개(+health_path)까지만 연다", async () => {
  const chain = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/p${i}`, `<a href="/p${i + 1}">next</a><a href="/login">Sign in</a>`]));
  const a = await app({ redirects: { "/": "/login" }, pages: { "/login": `<a href="/p0">Start</a>`, ...chain } });
  const pages = await crawl(a.url, { healthPath: "/health" });
  assert.deepEqual(pages.map((p) => [p.path, p.final_path]), [
    ["/", "/login"], ["/health", "/health"], ["/p0", "/p0"], ["/p1", "/p1"], ["/p2", "/p2"], ["/p3", "/p3"], ["/p4", "/p4"],
  ]);
});

test(";jsessionid= 같은 경로 매개변수는 떼고, 쿼리가 붙은 도착 주소도 같은 화면으로 보고 다시 열지 않는다", async () => {
  const a = await app({
    redirects: { "/": "/login?next=%2F" },
    pages: { "/login": `<a href="/login">Sign in</a><a href="/posts;jsessionid=AB12">Posts</a>`, "/posts": `<title>Posts</title>` },
  });
  const pages = await crawl(a.url);
  assert.deepEqual(pages.map((p) => [p.path, p.final_path]), [["/", "/login?next=%2F"], ["/posts", "/posts"]]);
  assert.deepEqual(pages[0].links, [{ text: "Sign in", path: "/login" }, { text: "Posts", path: "/posts" }]);
});

test("응답이 없는 페이지는 오류로 남기고, 둘러보기를 취소하면 거기서 멈춘다", async () => {
  const pages = await crawl("http://127.0.0.1:1", { timeoutMs: 500 });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].status, null);
  assert.ok(pages[0].error);

  const a = await app();
  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  assert.deepEqual(await crawl(a.url, { signal: controller.signal }), []);
});

const page = (path: string, status: number | null, finalPath: string | null = path): CrawledPage =>
  ({ path, final_path: finalPath, status, title: "", text: "", links: [], forms: [], error: status === null ? "boom" : null });

test("규칙 둘러보기 시나리오: 기준 환경에서 400 미만이었던 페이지만 visit, 넘어간 화면은 그 경로를 기대한다", () => {
  const scenario = crawlScenario([page("/", 200, "/login;jsessionid=AB12?next=%2F"), page("/admin", 403), page("/health", 200), page("/x", null)]);
  assert.deepEqual(scenario, {
    app_understanding: "Rule-based crawl of 2 pages (AI unavailable)",
    steps: [
      { title: "Open /", action: "visit", path: "/", form_action: null, fields: [], link_text: null, expect: { path_startswith: "/login", text_contains: [] } },
      { title: "Open /health", action: "visit", path: "/health", form_action: null, fields: [], link_text: null, expect: { path_startswith: null, text_contains: [] } },
    ],
  });
  assert.equal(crawlScenario([page("/", 200)])?.app_understanding, "Rule-based crawl of 1 page (AI unavailable)");
  // 넘어간 화면이 글 번호 주소면 환경마다 번호가 달라서 기대하지 않는다(경로 비교는 번호를 같은 것으로 보는 compare.ts가 맡는다).
  assert.equal(crawlScenario([page("/latest", 200, "/posts/17")])?.steps[0].expect.path_startswith, null);
  assert.equal(crawlScenario([page("/", 200, "/workspaces/123e4567-e89b-12d3-a456-426614174000")])?.steps[0].expect.path_startswith, null);
});

test("규칙 둘러보기 시나리오: 통과한 페이지가 없으면 null", () => {
  assert.equal(crawlScenario([page("/", 500), page("/health", null)]), null);
  assert.equal(crawlScenario([]), null);
});
