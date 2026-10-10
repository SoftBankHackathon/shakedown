// 테스트용 가짜 Claude Messages API. 진짜 키·네트워크를 쓰지 않고, 받은 요청을 seen에 남긴 뒤 reply로 답한다.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: any };
export type Reply = (res: ServerResponse, seen: Seen) => void;

export const json = (status: number, body: unknown): Reply => (res) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/** 실제 Messages API 응답 모양. Opus 5.5는 생각을 끌 수 없어서 thinking 블록이 text 앞에 온다. */
export function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_fake_01", type: "message", role: "assistant", model: "claude-opus-5-5", container: null, context_management: null,
    content: [{ type: "thinking", thinking: "", signature: "sig_fake" }, { type: "text", text, citations: null }],
    stop_reason, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 500 },
  };
}

export const answered = (body: unknown) => json(200, message(JSON.stringify(body)));

export async function startFakeClaude(t: TestContext, reply: Reply) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method!, url: req.url!, headers: req.headers, body: JSON.parse(raw) };
    seen.push(entry);
    reply(res, entry);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
