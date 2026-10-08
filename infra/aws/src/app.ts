import Fastify from 'fastify';
import { z } from 'zod';
import { ApiError, redact, requestSchema } from './model.js';
import { Manager } from './manager.js';

export function buildApp(manager: Manager) {
  const app = Fastify({ logger: false, bodyLimit: 32_768, requestTimeout: 150_000 });
  // No CORS and JSON-only mutations: browsers cannot drive this loopback control plane.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) return reply.code(403).send({ error: 'Browser-origin control requests are not allowed' });
    const hostname = (request.headers.host ?? '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(hostname)) return reply.code(403).send({ error: 'Invalid control host' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '요청 형식 오류', detail: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const e = error as Error & { statusCode?: number };
    const status = error instanceof ApiError ? error.statusCode : e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 502;
    return reply.code(status).send({ error: status >= 500 ? 'AWS 작업에 실패했습니다. 배포 로그와 계정 설정을 확인하세요.' : redact(e.message) });
  });
  const id = (params: unknown) => z.object({ id: z.string().regex(/^dep_[a-z0-9]{1,60}$/) }).parse(params).id;
  app.get('/health', async () => ({ ok: true, target: 'aws' }));
  app.post('/deployments', async (request, reply) => reply.code(202).send(manager.create(requestSchema.parse(request.body))));
  app.get('/deployments/:id', async request => manager.store.result(id(request.params)));
  app.delete('/deployments/:id', async (request, reply) => { await manager.remove(id(request.params)); return reply.code(204).send(); });
  app.get('/deployments/:id/logs', async request => {
    const query = z.object({ since: z.iso.datetime({ offset: true }).optional() }).strict().parse(request.query);
    return manager.logs(id(request.params), query.since ? new Date(query.since).toISOString() : undefined);
  });
  return app;
}
