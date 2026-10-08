import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "@shakedown/contracts/fixtures/deployment-blocked-then-fixed.json" with { type: "json" };
import { defaultScenario } from "../src/scenario.ts";

test("기본 시나리오는 contracts fixture의 시나리오와 같다", () => {
  assert.deepEqual(defaultScenario, fixture.scenario);
});
