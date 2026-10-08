// 시나리오의 {{email}} 같은 자리표시자를 실제 값으로 바꾼다.
// 한 번의 시운전에서 만든 값 한 세트를 모든 대상(local, aws)이 같이 쓴다.
import { randomBytes } from "node:crypto";
import type { Step } from "@shakedown/contracts";

export type Values = Record<string, string>;

export function newRunId(): string {
  return randomBytes(3).toString("hex");
}

export function makeValues(runId: string = newRunId()): Values {
  return {
    email: `sd${runId}@shakedown.test`,
    nickname: `sd${runId}`,
    password: `Sd${runId}!pw`,
    title: `[shakedown] post ${runId}`,
    content: `Shakedown body ${runId}. If you can read this, writes reach the DB.`,
    comment: `shakedown comment ${runId}`,
  };
}

export function fill(template: string, values: Values): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder {{${key}}}`);
    return values[key];
  });
}

function fillOptional(value: string | null | undefined, values: Values): string | null {
  return value == null ? null : fill(value, values);
}

export function fillStep(step: Step, values: Values): Step {
  return {
    ...step,
    path: fillOptional(step.path, values),
    form_action: fillOptional(step.form_action, values),
    link_text: fillOptional(step.link_text, values),
    fields: (step.fields ?? []).map((f) => ({ name: f.name, value: fill(f.value, values) })),
    expect: {
      path_startswith: fillOptional(step.expect?.path_startswith, values),
      text_contains: (step.expect?.text_contains ?? []).map((t) => fill(t, values)),
    },
  };
}
