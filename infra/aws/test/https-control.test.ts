import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsControl } from '../src/https-control.js';

test('HTTPS control rejects missing/unknown block state and malformed configuration flags', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const c = new HttpsControl('http://127.0.0.1:9301', 'project');
  for (body of [{}, { configured: 'false' }, { configured: true, url: 'https://app.example.com' },
    { configured: true, url: 'https://app.example.com', blocked: null },
    { configured: true, url: 'https://app.example.com', blocked: true }]) {
    await assert.rejects(c.gate(true, AbortSignal.timeout(1000)), /Invalid HTTPS gate response/);
  }
  body = { configured: true, url: 'https://app.example.com', blocked: false };
  assert.equal(await c.gate(true, AbortSignal.timeout(1000)), 'https://app.example.com');
  body = { configured: false };
  assert.equal(await c.gate(false, AbortSignal.timeout(1000)), undefined);
});
