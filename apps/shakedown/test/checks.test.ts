import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExpect } from "../src/checks.ts";

test("기대값이 없으면 HTTP 상태만 본다", () => {
  assert.deepEqual(checkExpect({ path_startswith: null, text_contains: [] }, "/", 200, ""), [
    { name: "http", ok: true, detail: "HTTP 200" },
  ]);
});

test("400 이상이면 http 검사가 실패한다", () => {
  assert.equal(checkExpect({ path_startswith: null, text_contains: [] }, "/x", 500, "")[0].ok, false);
});

test("경로가 다르면 fixture와 같은 문구로 실패한다", () => {
  const [, path] = checkExpect({ path_startswith: "/write", text_contains: [] }, "/", 200, "");
  assert.deepEqual(path, { name: "path", ok: false, detail: "ended on /, expected /write" });
});

test("화면 글자를 하나씩 확인한다", () => {
  const checks = checkExpect({ path_startswith: null, text_contains: ["hello", "bye"] }, "/", 200, "hello world");
  assert.deepEqual(checks.slice(1), [
    { name: "text", ok: true, detail: "'hello' shown" },
    { name: "text", ok: false, detail: "'bye' not shown" },
  ]);
});
