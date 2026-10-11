import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import type { Scenario } from "@shakedown/contracts";
import { defaultScenario, defaultScenarioOf } from "../src/scenario.ts";

test("기본 시나리오는 contracts fixture의 시나리오와 같다", () => {
  assert.deepEqual(defaultScenario, fixture.scenario);
});

test("기본 시나리오의 단계 제목은 요청 언어로 바뀌고 단계 내용(경로·폼·값·기대 글자)은 같다", () => {
  const ko = defaultScenarioOf("ko");
  assert.deepEqual(defaultScenarioOf("en"), defaultScenario);
  assert.deepEqual(ko.steps.map((s) => s.title), [
    "회원가입 화면 열기", "테스트 계정 만들기", "로그인 화면 열기", "로그인", "글쓰기 화면 열기", "글 올리기", "방금 쓴 글 열기", "댓글 달기",
  ]);
  assert.equal(defaultScenarioOf("ja").steps[5].title, "投稿する");
  const body = (s: Scenario) => s.steps.map(({ title: _title, ...rest }) => rest);
  assert.deepEqual(body(ko), body(defaultScenario));
  assert.deepEqual(body(defaultScenarioOf("ja")), body(defaultScenario));
});
