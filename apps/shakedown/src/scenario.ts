// kty-board 기본 시나리오(8단계)와 시나리오 모양 검사.
// 기본 시나리오는 packages/contracts fixture의 scenario와 똑같이 유지한다.
import type { ReportLang, Scenario } from "@shakedown/contracts";

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

// 단계 제목과 설명(언어별). 대시보드·보고서에 그대로 보인다. 영어는 fixture와 같다.
const TITLES: Record<ReportLang, { app: string; steps: string[] }> = {
  en: {
    app: "Rule-based journey (AI unavailable)",
    steps: ["Open sign-up page", "Create a test account", "Open sign-in page", "Sign in", "Open the editor", "Publish a post", "Open the new post", "Leave a comment"],
  },
  ko: {
    app: "규칙 기반 기본 시나리오(AI 미사용)",
    steps: ["회원가입 화면 열기", "테스트 계정 만들기", "로그인 화면 열기", "로그인", "글쓰기 화면 열기", "글 올리기", "방금 쓴 글 열기", "댓글 달기"],
  },
  ja: {
    app: "ルールベースの基本シナリオ（AI 不使用）",
    steps: ["会員登録画面を開く", "テストアカウントを作成", "ログイン画面を開く", "ログイン", "投稿画面を開く", "投稿する", "新しい投稿を開く", "コメントを書く"],
  },
};

function build(lang: ReportLang): Scenario {
  const [join, account, signInPage, signIn, editor, publish, open, comment] = TITLES[lang].steps;
  return {
    app_understanding: TITLES[lang].app,
    steps: [
      visit(join, "/join", "/join"),
      submit(account, "/join", { email: "{{email}}", nickname: "{{nickname}}", password: "{{password}}" }),
      visit(signInPage, "/"),
      submit(signIn, "/login", { email: "{{email}}", password: "{{password}}" }),
      visit(editor, "/write", "/write"),
      submit(publish, "/api/posts/write", { title: "{{title}}", content: "{{content}}" }, ["{{title}}"]),
      {
        title: open,
        action: "click_link",
        path: null,
        form_action: null,
        fields: [],
        link_text: "{{title}}",
        expect: { path_startswith: null, text_contains: ["{{content}}"] },
      },
      submit(comment, "/api/comments", { content: "{{comment}}" }, ["{{comment}}"]),
    ],
  };
}

// 언어마다 한 번만 만든다. 영어 것은 지금까지처럼 defaultScenario 하나다.
const BY_LANG: Record<ReportLang, Scenario> = { en: build("en"), ko: build("ko"), ja: build("ja") };

/** kty-board 기본 시나리오. 제목만 lang으로 바뀌고 경로·폼·값·기대 글자는 언어와 상관없다. */
export function defaultScenarioOf(lang: ReportLang = "en"): Scenario {
  return BY_LANG[lang];
}

export const defaultScenario: Scenario = BY_LANG.en;
