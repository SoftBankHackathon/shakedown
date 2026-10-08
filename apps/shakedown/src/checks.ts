// 단계가 끝난 뒤 기대값(expect)과 실제 결과를 맞춰 본다.
import type { Step, StepResult } from "@shakedown/contracts";

export type Check = StepResult["checks"][number];

export function checkExpect(expect: Step["expect"], finalPath: string, finalStatus: number, text: string): Check[] {
  const checks: Check[] = [{ name: "http", ok: finalStatus < 400, detail: `HTTP ${finalStatus}` }];

  const want = expect.path_startswith;
  if (want) {
    const ok = finalPath.startsWith(want);
    checks.push({ name: "path", ok, detail: ok ? `ended on ${finalPath}` : `ended on ${finalPath}, expected ${want}` });
  }
  for (const t of expect.text_contains ?? []) {
    const ok = text.includes(t);
    checks.push({ name: "text", ok, detail: ok ? `'${t}' shown` : `'${t}' not shown` });
  }
  return checks;
}
