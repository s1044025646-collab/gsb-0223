import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, JsonPatchError } from "../jsonPatch.js";

test("支持六种 JSON Patch 操作并满足固定预期", () => {
  const source = {
    list: [{ id: 1 }, { id: 2 }],
    values: { a: 10, nested: { keep: true } },
    slash: {},
  };
  const patch = [
    { op: "add", path: "/list/1", value: { id: 1.5 } },
    { op: "test", path: "/list/2/id", value: 2 },
    { op: "add", path: "/slash/a~1b", value: "斜杠属性" },
    { op: "replace", path: "/values/a", value: 20 },
    { op: "move", from: "/values/nested", path: "/values/moved" },
    { op: "copy", from: "/list/0", path: "/copied" },
    { op: "test", path: "/values/moved/keep", value: true },
  ];
  assert.deepEqual(applyPatch(source, patch), {
    list: [{ id: 1 }, { id: 1.5 }, { id: 2 }],
    values: { a: 20, moved: { keep: true } },
    slash: { "a/b": "斜杠属性" },
    copied: { id: 1 },
  });
});

test("支持根文档、null 与缺失的区别", () => {
  assert.equal(applyPatch(null, [{ op: "test", path: "", value: null }]), null);
  assert.deepEqual(applyPatch(null, [{ op: "replace", path: "", value: { ok: true } }]), { ok: true });
  assert.deepEqual(applyPatch({ a: null }, [{ op: "test", path: "/a", value: null }]), { a: null });
  assert.throws(
    () => applyPatch({ a: null }, [{ op: "test", path: "/missing", value: null }]),
    (error: JsonPatchError) => error.details.index === 0 && error.details.code === "POINTER_NOT_FOUND",
  );
});

test("严格处理数组边界和末尾追加", () => {
  assert.deepEqual(applyPatch([1, 2], [{ op: "add", path: "/-", value: 3 }]), [1, 2, 3]);
  assert.deepEqual(applyPatch([1, 2], [{ op: "add", path: "/2", value: 3 }]), [1, 2, 3]);
  assert.throws(() => applyPatch([1], [{ op: "add", path: "/2", value: 3 }]), /越界/);
  assert.throws(() => applyPatch([1], [{ op: "remove", path: "/01" }]), /下标/);
  assert.throws(() => applyPatch([1], [{ op: "remove", path: "/-"}]), /不能读取/);
});

test("copy 产生独立深复制，且失败不会修改输入", () => {
  const input = { source: { nested: [1] }, target: [] };
  const result = applyPatch(input, [
    { op: "copy", from: "/source", path: "/target/0" },
    { op: "add", path: "/target/0/nested/0", value: 99 },
  ]) as { source: { nested: number[] } };
  assert.deepEqual(result.source.nested, [1]);
  assert.deepEqual(input, { source: { nested: [1] }, target: [] });

  const failed = () => applyPatch(input, [
    { op: "add", path: "/temp", value: "中间状态" },
    { op: "test", path: "/missing", value: 1 },
  ]);
  assert.throws(failed, JsonPatchError);
  assert.deepEqual(input, { source: { nested: [1] }, target: [] });
});

test("拒绝非法 move、失败 test 并报告序号和路径", () => {
  assert.throws(
    () => applyPatch({ a: {} }, [{ op: "move", from: "/a", path: "/a/child" }]),
    (error: JsonPatchError) => error.details.index === 0 && error.details.code === "INVALID_MOVE",
  );
  assert.throws(
    () => applyPatch({ a: 1 }, [
      { op: "replace", path: "/a", value: 2 },
      { op: "test", path: "/a", value: 1 },
    ]),
    (error: JsonPatchError) => error.details.index === 1 && error.details.path === "/a",
  );
});
