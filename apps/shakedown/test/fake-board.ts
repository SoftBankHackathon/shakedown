// 테스트용 가짜 kty-board. 실제 앱과 같은 경로·폼·리다이렉트를 흉내 낸다.
// instances: 2로 띄우면 요청을 서버 2대에 번갈아 보내고 세션은 서버마다 따로 둔다
// → AWS에서 로그인이 풀리는 데모 상황을 그대로 재현한다.
// 데모 버그가 아직 정해지지 않아서 원인 보고서의 다른 이야기도 옵션으로 재현한다.
//   sharedSessions: true  → 세션 저장소를 서버끼리 공유한다(로그인은 유지된다).
//   sharedPosts: false    → 글 저장소를 서버마다 따로 둔다(방금 쓴 글이 다른 서버에선 안 보인다).
//                           로그인 단계는 통과해야 이 이야기가 보이므로 회원 정보는 계속 공유한다.
//   failJoin: 500         → 회원가입 POST가 그 상태 코드로 실패한다(DB 연결 실패 흉내).
//   delayMs: 5            → 모든 응답을 그만큼 늦춘다(진행 중 상태를 관찰할 때).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Member = { email: string; nickname: string; password: string };
type Post = { id: number; title: string; content: string; comments: string[] };

export type FakeBoardOptions = { instances?: number; sharedSessions?: boolean; sharedPosts?: boolean; failJoin?: number; delayMs?: number };

export async function startFakeBoard(options: FakeBoardOptions = {}) {
  const instances = options.instances ?? 1;
  const members = new Map<string, Member>();
  const postStores = Array.from({ length: options.sharedPosts === false ? instances : 1 }, (): Post[] => []);
  const sessions = Array.from({ length: options.sharedSessions ? 1 : instances }, () => new Map<string, string>()); // 세션ID → email
  let turn = 0;
  let nextSession = 1;

  const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  const send = (res: ServerResponse, status: number, html: string) =>
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(html));
  const redirect = (res: ServerResponse, location: string, cookie?: string) =>
    res.writeHead(302, cookie ? { location, "set-cookie": cookie } : { location }).end();

  const joinForm = `<form action="/join" method="post"><input name="email"><input name="nickname"><input type="password" name="password"></form>`;
  const loginForm = `<h1>Board Login</h1><form action="/login" method="post"><input name="email"><input type="password" name="password"></form>`;
  const detail = (p: Post) =>
    `<h2>${p.title}</h2><p>${p.content}</p>` +
    `<form action="/api/comments" method="post"><input type="hidden" name="postId" value="${p.id}"><textarea name="content"></textarea></form>` +
    p.comments.map((c, i) => `<p>${c}</p><form action="/api/comments/${i + 1}/delete" method="post"><input type="hidden" name="postId" value="${p.id}"></form>`).join("");

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    let body = "";
    for await (const chunk of req) body += chunk;
    return new URLSearchParams(body);
  }

  const server = createServer(async (req, res) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const n = turn++ % instances;
    const store = sessions[n % sessions.length];
    const posts = postStores[n % postStores.length];
    const sid = /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const user = sid ? store.get(sid) : undefined;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const route = `${req.method} ${path}`;

    if (route === "GET /join") return send(res, 200, joinForm);
    if (route === "POST /join") {
      const f = await readForm(req);
      if (options.failJoin) return send(res, options.failJoin, "Whitelabel Error Page");
      const email = f.get("email") ?? "";
      if (members.has(email)) return send(res, 200, `이미 존재하는 회원입니다. ${joinForm}`);
      members.set(email, { email, nickname: f.get("nickname") ?? "", password: f.get("password") ?? "" });
      return redirect(res, "/");
    }
    if (route === "GET /") return send(res, 200, loginForm);
    if (route === "POST /login") {
      const f = await readForm(req);
      const m = members.get(f.get("email") ?? "");
      if (!m || m.password !== f.get("password")) return send(res, 200, `로그인 실패 ${loginForm}`);
      const id = `s${nextSession++}`;
      store.set(id, m.email);
      return redirect(res, "/board", `JSESSIONID=${id}; Path=/; HttpOnly`);
    }
    if (!user) return redirect(res, "/");

    if (route === "GET /board") {
      return send(res, 200, `<p>${members.get(user)?.nickname}님 환영합니다!</p>` + posts.map((p) => `<a href="/posts/${p.id}">${p.title}</a>`).join(""));
    }
    if (route === "GET /write") {
      return send(res, 200, `<form action="/api/posts/write" method="post"><input name="title"><textarea name="content"></textarea></form>`);
    }
    if (route === "POST /api/posts/write") {
      const f = await readForm(req);
      posts.push({ id: posts.length + 1, title: f.get("title") ?? "", content: f.get("content") ?? "", comments: [] });
      return redirect(res, "/board");
    }
    if (route === "POST /api/comments") {
      const f = await readForm(req);
      const post = posts.find((p) => String(p.id) === f.get("postId"));
      if (!post) return send(res, 400, "Bad Request: postId");
      post.comments.push(f.get("content") ?? "");
      return redirect(res, `/posts/${post.id}/view`);
    }
    const m = /^GET \/posts\/(\d+)(\/view)?$/.exec(route);
    const post = m && posts.find((p) => p.id === Number(m[1]));
    if (post) return send(res, 200, detail(post));
    return send(res, 404, "Not Found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
