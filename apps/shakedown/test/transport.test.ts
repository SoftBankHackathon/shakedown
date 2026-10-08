import { test } from "node:test";
import assert from "node:assert/strict";
import { createTunnelLookup } from "../src/transport.ts";
import type { LookupFunction } from "node:net";

const miss = Object.assign(new Error("DNS cache miss"), { code: "ENOTFOUND" });
const run = (fn: LookupFunction, host: string, all = false) => new Promise((resolve,reject) =>
  fn(host,{all},(error,address,family) => error ? reject(error) : resolve({address,family})));

test("Quick Tunnel DNS miss uses fallback for both lookup callback shapes", async () => {
  const fn = createTunnelLookup(async () => { throw miss; }, async () => ["198.51.100.1"]);
  assert.deepEqual(await run(fn,"example.trycloudflare.com"), {address:"198.51.100.1",family:4});
  assert.deepEqual(await run(fn,"example.trycloudflare.com",true), {address:[{address:"198.51.100.1",family:4}],family:4});
});

test("system DNS success never uses external fallback", async () => {
  const fn = createTunnelLookup(async () => [{address:"127.0.0.1",family:4}], async () => { throw new Error("must not call"); });
  assert.deepEqual(await run(fn,"example.trycloudflare.com"),{address:"127.0.0.1",family:4});
});

test("private and lookalike hostnames never query public fallback", async () => {
  let called = false;
  const fn = createTunnelLookup(async () => { throw miss; },async () => {called=true; return [];});
  for (const host of ["internal.local","trycloudflare.com.evil.test","example.com","trycloudflare.com"])
    await assert.rejects(run(fn,host),miss);
  assert.equal(called,false);
});
