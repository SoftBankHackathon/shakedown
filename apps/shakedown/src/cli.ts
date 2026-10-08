// 명령줄에서 시운전 한 번을 돌리고 결과 JSON을 출력한다.
// 사용: node src/cli.ts --baseline <url> --candidate <url> [--baseline-name local] [--candidate-name aws]
import { parseArgs } from "node:util";
import { runShakedown } from "./shakedown.ts";

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

const result = await runShakedown({
  baseline: { name: values["baseline-name"], url: baseline },
  candidate: { name: values["candidate-name"], url: candidate },
  timeoutMs,
});
console.log(JSON.stringify(result, null, 2));
