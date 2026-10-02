import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PatchOperation } from "../jsonPatch.js";
import { ConflictError, PatchService } from "../store.js";

const directory = mkdtempSync(join(tmpdir(), "json-patch-"));
const databasePath = join(directory, "service.sqlite");
after(() => rmSync(directory, { recursive: true, force: true }));

test("预览、原子提交、版本冲突、失败重查和重启持久化", () => {
  const service = new PatchService(databasePath);
  service.createDocument("doc", { list: ["a"], meta: { v: 1 } });

  const patch: PatchOperation[] = [
    { op: "add", path: "/list/1", value: "b" },
    { op: "test", path: "/meta/v", value: 1 },
  ];
  assert.deepEqual(service.preview("doc", 0, patch).result, { list: ["a", "b"], meta: { v: 1 } });
  assert.equal(service.getDocument("doc").currentVersion, 0);

  assert.equal(service.commit("doc", 0, patch).version, 1);
  const stalePatch: PatchOperation[] = [{ op: "add", path: "/stale", value: true }];
  assert.throws(
    () => service.commit("doc", 0, stalePatch),
    (error: ConflictError) => error.code === "VERSION_CONFLICT" && error.currentVersion === 1,
  );

  const failedPatch: PatchOperation[] = [
    { op: "add", path: "/willRollback", value: "临时值" },
    { op: "test", path: "/meta/v", value: 999 },
  ];
  assert.throws(() => service.commit("doc", 1, failedPatch));
  assert.deepEqual(service.getDocument("doc"), {
    name: "doc",
    currentVersion: 1,
    content: { list: ["a", "b"], meta: { v: 1 } },
  });
  assert.equal(service.history("doc").length, 1);
  service.close();

  const restarted = new PatchService(databasePath);
  assert.equal(restarted.getDocument("doc").currentVersion, 1);
  assert.deepEqual(restarted.getVersion("doc", 0).content, { list: ["a"], meta: { v: 1 } });
  assert.deepEqual(restarted.exportDocument("doc").content, { list: ["a", "b"], meta: { v: 1 } });
  restarted.close();
});
