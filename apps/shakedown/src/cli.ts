// 명령줄에서 시운전 한 번을 돌리고 결과 JSON을 출력한다.
// 사용: node src/cli.ts --baseline <url> --candidate <url> [--baseline-name local] [--candidate-name aws]
import { parseArgs } from "node:util";
import { runShakedown } from "./shakedown.ts";
import { chooseScenario } from "./choose.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    "baseline-name": { type: "string", default: "local" },
    "candidate-name": { type: "string", default: "aws" },
    "timeout-ms": { type: "string", default: "10000" },
  },
});

const { baseline, candidate } = values;
const timeoutMs = Number(values["timeout-ms"]);
if (!baseline || !candidate || !URL.canParse(baseline) || !URL.canParse(candidate) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
  console.error("usage: node src/cli.ts --baseline <url> --candidate <url> [--baseline-name local] [--candidate-name aws] [--timeout-ms 10000]");
  process.exit(2);
}

const target = { name: values["baseline-name"], url: baseline };
// 시운전 API와 같은 순서로 시나리오를 고른다(알려진 시나리오 → 규칙 둘러보기). CLI는 AI를 부르지 않는다.
const choice = await chooseScenario(target, { ai: {}, timeoutMs }).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
const result = await runShakedown({
  baseline: target,
  candidate: { name: values["candidate-name"], url: candidate },
  scenario: choice.scenario,
  timeoutMs,
});
console.log(JSON.stringify({ scenario: result.scenario, scenario_source: choice.source, steps: result.steps, verdict: result.verdict }, null, 2));
