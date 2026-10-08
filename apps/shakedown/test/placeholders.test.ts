import { test } from "node:test";
import assert from "node:assert/strict";
import { fill, fillStep, makeValues } from "../src/placeholders.ts";

test("같은 runId면 값 세트가 같다", () => {
  assert.deepEqual(makeValues("abc123"), makeValues("abc123"));
  assert.equal(makeValues("abc123").nickname, "sdabc123");
});

test("runId를 안 주면 실행마다 다른 값이 나온다", () => {
  assert.notEqual(makeValues().email, makeValues().email);
});

test("자리표시자를 값으로 바꾼다", () => {
  assert.equal(fill("hi {{nickname}}!", { nickname: "sd1" }), "hi sd1!");
});

test("모르는 자리표시자는 오류를 낸다", () => {
  assert.throws(() => fill("{{nope}}", {}), /unknown placeholder \{\{nope\}\}/);
});

test("단계의 모든 문자열 칸을 채운다", () => {
  const values = makeValues("abc123");
  const step = fillStep(
    {
      title: "Publish a post",
      action: "submit_form",
      path: null,
      form_action: "/api/posts/write",
      link_text: null,
      fields: [{ name: "title", value: "{{title}}" }],
      expect: { path_startswith: null, text_contains: ["{{title}}"] },
    },
    values,
  );
  assert.deepEqual(step.fields, [{ name: "title", value: "[shakedown] post abc123" }]);
  assert.deepEqual(step.expect.text_contains, ["[shakedown] post abc123"]);
});
