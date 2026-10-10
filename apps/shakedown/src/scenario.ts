// kty-board 기본 시나리오(8단계)와 시나리오 모양 검사.
// 기본 시나리오는 packages/contracts fixture의 scenario와 똑같이 유지한다.
import type { Scenario } from "@shakedown/contracts";

const ACTIONS = new Set(["visit", "submit_form", "click_link"]);

/** 단계마다 제목과 아는 action이 있는지. 단계가 0개인 시나리오는 아무것도 안 하고 PASS가 되므로 받지 않는다. */
export function isScenario(value: unknown): value is Scenario {
  const s = value as Partial<Scenario> | null;
  return (
    Array.isArray(s?.steps) && s.steps.length > 0 &&
    s.steps.every((step) => typeof step?.title === "string" && ACTIONS.has(step.action))
  );
}

const visit = (title: string, path: string, pathStartsWith: string | null = null) => ({
  title,
  action: "visit" as const,
  path,
  form_action: null,
  fields: [],
  link_text: null,
  expect: { path_startswith: pathStartsWith, text_contains: [] },
});

const submit = (title: string, formAction: string, fields: Record<string, string>, textContains: string[] = []) => ({
  title,
  action: "submit_form" as const,
  path: null,
  form_action: formAction,
  fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
  link_text: null,
  expect: { path_startswith: null, text_contains: textContains },
});

export const defaultScenario: Scenario = {
  app_understanding: "Rule-based journey (AI unavailable)",
  steps: [
    visit("Open sign-up page", "/join", "/join"),
    submit("Create a test account", "/join", { email: "{{email}}", nickname: "{{nickname}}", password: "{{password}}" }),
    visit("Open sign-in page", "/"),
    submit("Sign in", "/login", { email: "{{email}}", password: "{{password}}" }),
    visit("Open the editor", "/write", "/write"),
    submit("Publish a post", "/api/posts/write", { title: "{{title}}", content: "{{content}}" }, ["{{title}}"]),
    {
      title: "Open the new post",
      action: "click_link",
      path: null,
      form_action: null,
      fields: [],
      link_text: "{{title}}",
      expect: { path_startswith: null, text_contains: ["{{content}}"] },
    },
    submit("Leave a comment", "/api/comments", { content: "{{comment}}" }, ["{{comment}}"]),
  ],
};
