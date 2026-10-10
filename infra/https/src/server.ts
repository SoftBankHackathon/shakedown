import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { settingsSchema } from "./model.js";
import { Manager } from "./manager.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

// All instances using this SQLite file serialize cloud mutations behind a process lock.
process.umask(0o077);
function loadSettings() {
  try {
    return settingsSchema.parse(
      JSON.parse(
        readFileSync(
          process.env.SHAKEDOWN_HTTPS_CONFIG ??
            new URL("../config.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  } catch {
    throw new Error(
      "HTTPS 연결 설정 파일을 확인하세요. 설정 원문은 출력하지 않습니다.",
    );
  }
}
const settings = loadSettings();
const owner = randomUUID(),
  store = new Store(settings.statePath);
store.acquire(owner);
const manager = new Manager(settings, store),
  app = createApp(manager);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  manager.stop();
  await app.close();
  await manager.drain();
  store.release(owner);
  store.close();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
try {
  await app.listen({ host: "127.0.0.1", port: 9301 });
  manager.start();
  console.log("Shakedown HTTPS: http://127.0.0.1:9301");
} catch {
  store.release(owner);
  store.close();
  throw new Error(
    "HTTPS 서비스를 시작할 수 없습니다. 포트와 설정을 확인하세요.",
  );
}
