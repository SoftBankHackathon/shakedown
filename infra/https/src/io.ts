import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpsError } from "./model.js";
const exec = promisify(execFile);
export interface IO {
  command(tool: "aws" | "az" | "gcloud", args: string[]): Promise<any>;
  http(
    url: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<any>;
}
export const io: IO = {
  async command(tool, args) {
    try {
      const r = await exec(tool, args, {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          AWS_PAGER: "",
          CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
          AZURE_CORE_NO_COLOR: "1",
        },
      });
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    } catch {
      throw new HttpsError(
        "PROVIDER_COMMAND_FAILED",
        tool + " 작업 실패: 전용 계정·권한·기반 리소스를 확인하세요.",
        502,
      );
    }
  },
  async http(url, method = "GET", body, headers = {}) {
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpsError(
        "PROVIDER_UNREACHABLE",
        "설정 API에 연결할 수 없습니다.",
        502,
      );
    }
    if (!r.ok)
      throw new HttpsError(
        "PROVIDER_HTTP_" + r.status,
        "설정 API 요청 실패 (" + r.status + ").",
        r.status === 404 ? 404 : 502,
      );
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  },
};
export function aws(
  io: IO,
  c: any,
  service: string,
  command: string,
  args: string[] = [],
) {
  return io.command("aws", [
    service,
    command,
    ...args,
    "--profile",
    c.profile,
    "--region",
    c.region,
    "--output",
    "json",
  ]);
}
export function az(io: IO, c: any, args: string[]) {
  return io.command("az", [
    ...args,
    "--subscription",
    c.subscriptionId,
    "--output",
    "json",
  ]);
}
export function gcp(io: IO, c: any, args: string[]) {
  return io.command("gcloud", [
    ...args,
    "--configuration",
    c.configuration,
    "--project",
    c.project,
    "--format=json",
    "--quiet",
  ]);
}
export function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
