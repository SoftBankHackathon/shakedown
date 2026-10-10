// 테스트용 가짜 범용 앱(게시판이 아닌 앱). examples/http-node처럼 어느 경로든 JSON {language, database, count}를 준다.
//   status: 503    → 모든 응답을 그 상태 코드로 준다(배포가 깨진 환경 흉내).
//   pages: {path: html} → 그 경로는 HTML 화면을 준다(링크·폼이 있는 앱 흉내).
//   redirects: {path: location} → 그 경로는 302로 보낸다.
// hits에 받은 요청("GET /")을 모두 남겨 둘러보기가 GET만 보냈는지 확인한다.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeAppOptions = { status?: number; pages?: Record<string, string>; redirects?: Record<string, string> };

export async function startFakeApp(options: FakeAppOptions = {}) {
  const hits: string[] = [];
  const status = options.status ?? 200;
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const location = options.redirects?.[path];
    if (location) return void res.writeHead(302, { location }).end();
    const html = options.pages?.[path];
    if (html !== undefined) return void res.writeHead(status, { "content-type": "text/html" }).end(`<!doctype html><html>${html}</html>`);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ language: "node", database: false, count: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
