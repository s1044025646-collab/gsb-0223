import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { PatchOperation } from "./jsonPatch.js";
import { PatchService } from "./store.js";

const databasePath = resolve("data/demo.sqlite");
rmSync(databasePath, { force: true });
rmSync(`${databasePath}-wal`, { force: true });
rmSync(`${databasePath}-shm`, { force: true });

const service = new PatchService(databasePath);
service.createDocument("demo", {
  items: [{ id: "first" }],
  checks: { enabled: true },
  "a/b": null,
});

const successfulPatch: PatchOperation[] = [
  { op: "add", path: "/items/1", value: { id: "inserted" } },
  { op: "add", path: "/a~1b", value: "斜杠属性已设置" },
  { op: "move", from: "/checks/enabled", path: "/checks/wasEnabled" },
  { op: "copy", from: "/items/0", path: "/items/-" },
  { op: "test", path: "/checks/wasEnabled", value: true },
];

console.log("初始版本 0:");
console.log(JSON.stringify(service.getDocument("demo").content, null, 2));
console.log("\n成功提交版本 1:");
console.log(JSON.stringify(service.commit("demo", 0, successfulPatch), null, 2));

const failedPatch: PatchOperation[] = [
  { op: "add", path: "/temporary", value: "这个中间修改不应保留" },
  { op: "remove", path: "/items/99" },
  { op: "test", path: "/checks/wasEnabled", value: false },
];

console.log("\n故意提交失败补丁：");
try {
  service.commit("demo", 1, failedPatch);
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error && "details" in error
      ? (error as { details: unknown }).details
      : String(error),
  }, null, 2));
}

console.log("\n失败后重查，仍是版本 1，temporary 不存在：");
console.log(JSON.stringify(service.getDocument("demo"), null, 2));
console.log("\n修订记录：");
console.log(JSON.stringify(service.history("demo"), null, 2));
service.close();
