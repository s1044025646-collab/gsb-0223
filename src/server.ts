import { resolve } from "node:path";
import { createApp } from "./http.js";
import { PatchService } from "./store.js";

const dataPath = process.env.JSON_PATCH_DB ?? resolve("data/json-patch.sqlite");
const service = new PatchService(dataPath);
const server = createApp(service);
const requestedPort = process.env.PORT ? Number(process.env.PORT) : 0;

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  console.error("PORT 必须是 0 到 65535 的整数");
  process.exit(1);
}

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") return;
  console.log(`JSON Patch 服务已启动: http://127.0.0.1:${address.port}`);
  console.log(`数据库: ${dataPath}`);
});

function shutdown(): void {
  server.close(() => {
    service.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
