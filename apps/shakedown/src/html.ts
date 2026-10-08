// 의존성 없이 HTML에서 폼, 링크, 화면 글자를 꺼낸다.
// 대상은 서버가 그린 단순한 페이지(Thymeleaf 등)라서 정규식으로 충분하다.

export type Form = { action: string; method: string; fields: Record<string, string> };

function attr(tag: string, name: string): string | null {
  // 따옴표 없는 값(type=checkbox)도 HTML에서는 허용된다.
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4]) : null;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// 값 없는 속성(checked, disabled)이 태그에 있는지. 다른 속성의 값 안에 든 같은 글자는 무시한다.
function hasFlag(tag: string, name: string): boolean {
  const bare = tag.replace(/=\s*("[^"]*"|'[^']*')/g, "");
  return new RegExp(`\\s${name}(?=[\\s/>=]|$)`, "i").test(bare);
}

/** 브라우저가 보낼 값. 누르지 않은 버튼, 체크하지 않은 상자·라디오, disabled 칸은 보내지 않는다(null). */
function submittedValue(input: string): string | null {
  const type = (attr(input, "type") ?? "text").toLowerCase();
  if (hasFlag(input, "disabled") || ["submit", "button", "image", "reset", "file"].includes(type)) return null;
  if (type === "checkbox" || type === "radio") return hasFlag(input, "checked") ? (attr(input, "value") ?? "on") : null;
  return attr(input, "value") ?? "";
}

/** action이 정확히 같은 폼을 찾는다. 숨은 입력칸을 포함한 기본값을 fields에 담는다. */
export function findForm(html: string, action: string): Form | null {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const formTag = m[1];
    if (attr(` ${formTag}`, "action") !== action) continue;
    const fields: Record<string, string> = {};
    for (const input of m[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(input[0], "name");
      const value = submittedValue(input[0]);
      if (name && value !== null) fields[name] = value;
    }
    for (const area of m[2].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = attr(` ${area[1]}`, "name");
      if (name) fields[name] = decode(area[2]);
    }
    return { action, method: (attr(` ${formTag}`, "method") ?? "get").toUpperCase(), fields };
  }
  return null;
}

/** 보이는 글자에 text가 들어 있는 첫 링크의 href를 돌려준다. */
export function findLinkByText(html: string, text: string): string | null {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (pageText(m[2]).includes(text)) return attr(` ${m[1]}`, "href");
  }
  return null;
}

/** 태그를 지운 화면 글자. 공백은 한 칸으로 줄인다. */
export function pageText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decode(text).replace(/\s+/g, " ").trim();
}
