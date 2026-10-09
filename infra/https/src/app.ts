import Fastify from "fastify";
import { z } from "zod";
import { HttpsError, idSchema, targetSchema } from "./model.js";
import type { Manager } from "./manager.js";
export function createApp(manager: Manager) {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.headers.origin)
      return reply
        .code(403)
        .send({
          code: "LOCAL_ONLY",
          message: "엔진을 통한 내부 요청만 허용합니다.",
        });
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof HttpsError)
      return reply
        .code(e.statusCode)
        .send({ code: e.code, message: e.message });
    if (e instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          code: "INVALID_REQUEST",
          message: "도메인과 연결 설정을 확인하세요.",
        });
    const status = (e as { statusCode?: number }).statusCode;
    return reply
      .code(status === 413 ? 413 : 500)
      .send({ code: "REQUEST_FAILED", message: "요청을 처리하지 못했습니다." });
  });
  const params = (p: unknown) =>
    z.object({ id: idSchema, target: targetSchema }).parse(p);
  const base = "/projects/:id/targets/:target/https";
  app.get(base, async (req, reply) => {
    const p = params(req.params),
      result = manager.get(p.id, p.target);
    if (!result)
      throw new HttpsError("NOT_FOUND", "등록된 HTTPS 연결이 없습니다.", 404);
    return result;
  });
  app.post(base, async (req, reply) => {
    const p = params(req.params),
      result = manager.create(p.id, p.target, req.body);
    reply.code(202);
    return result;
  });
  app.post(base + "/recheck", async (req, reply) => {
    const p = params(req.params);
    reply.code(202);
    return manager.recheck(p.id, p.target);
  });
  app.post("/projects/:id/targets/aws/https/gate", async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const { open } = z.object({ open: z.boolean() }).strict().parse(req.body);
    return manager.gate(id, open);
  });
  return app;
}
