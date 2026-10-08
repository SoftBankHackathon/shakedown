import { test } from "node:test";
import assert from "node:assert/strict";
import { findForm, findLinkByText, pageText } from "../src/html.ts";

// kty-board detail.html을 서버가 그린 모양 (댓글 폼 + 같은 페이지의 삭제 폼)
const detail = `
<h2>[shakedown] post abc</h2>
<form action="/api/comments" method="post" class="mb-4">
  <input type="hidden" name="postId" value="10">
  <textarea name="content" class="form-control" rows="2" required></textarea>
  <button type="submit">등록</button>
</form>
<form action="/api/comments/3/delete" method="post">
  <input type="hidden" name="postId" value="10">
</form>`;

test("action이 정확히 같은 폼을 찾고 숨은 입력값을 기본값으로 담는다", () => {
  assert.deepEqual(findForm(detail, "/api/comments"), {
    action: "/api/comments",
    method: "POST",
    fields: { postId: "10", content: "" },
  });
});

test("action이 앞부분만 같은 폼은 고르지 않는다", () => {
  assert.equal(findForm(detail, "/api/comments/3")?.action, undefined);
  assert.equal(findForm(detail, "/nope"), null);
});

test("보이는 글자로 링크를 찾는다", () => {
  const board = `<a href="/logout">로그아웃</a>
    <a href="/posts/10"
       class="title">
       [shakedown] post abc
    </a>`;
  assert.equal(findLinkByText(board, "[shakedown] post abc"), "/posts/10");
  assert.equal(findLinkByText(board, "없는 글"), null);
});

test("화면 글자는 태그와 스크립트를 빼고 엔티티를 푼다", () => {
  assert.equal(pageText("<script>x()</script><p>A &amp; B</p>\n<b>C</b>"), "A & B C");
});

test("브라우저처럼 체크하지 않은 상자와 버튼 값은 보내지 않는다", () => {
  const html = `<form action="/f" method="post">
    <input type="checkbox" name="notify" value="yes">
    <input type="checkbox" name="agree" value="on" checked>
    <input type="radio" name="size" value="s"><input type="radio" name="size" value="m" checked>
    <input type="submit" name="go" value="Go"><input name="title" value="t">
  </form>`;
  assert.deepEqual(findForm(html, "/f")?.fields, { agree: "on", size: "m", title: "t" });
});

test("disabled 입력칸은 보내지 않고, 글자 속 checked는 체크로 보지 않는다", () => {
  const html = `<form action="/f" method="post">
    <input name="role" value="admin" disabled>
    <input type="checkbox" name="x" title="not checked">
    <input type=CHECKBOX name="y" checked>
  </form>`;
  assert.deepEqual(findForm(html, "/f")?.fields, { y: "on" });
});
