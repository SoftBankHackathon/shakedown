// 시운전 API 서버를 띄운다. 사용: node --env-file-if-exists=.env src/main.ts
// PORT(기본 9201), HOST(기본 127.0.0.1). 엔진이 다른 PC에서 부르면 HOST=0.0.0.0으로 띄운다.
import type { AddressInfo } from "node:net";
import { createShakedownServer } from "./server.ts";

const host = process.env.HOST ?? "127.0.0.1";
const server = createShakedownServer();
server.listen(Number(process.env.PORT ?? 9201), host, () => {
  console.log(`shakedown api listening on ${host}:${(server.address() as AddressInfo).port}`);
});
