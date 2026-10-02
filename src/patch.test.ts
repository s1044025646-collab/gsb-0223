import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, jsonEqual } from './patch.js';
import { PatchError } from './errors.js';
import { JsonValue } from './pointer.js';

function mustFail(input: JsonValue, ops: unknown[]): PatchError {
  assert.throws(
    () => applyPatch(input, ops),
    (err: unknown) => err instanceof PatchError,
  );
  try {
    applyPatch(input, ops);
  } catch (err) {
    return err as PatchError;
  }
  throw new Error('unreachable');
}

test('add: 对象新增/数组插入后移/末尾追加/- 追加/根替换', () => {
  assert.deepEqual(
    applyPatch({ a: [1, 2] }, [
      { op: 'add', path: '/b', value: 3 },
      { op: 'add', path: '/a/1', value: 9 },
    ]),
    { a: [1, 9, 2], b: 3 },
  );
  assert.deepEqual(applyPatch({ a: [1] }, [{ op: 'add', path: '/a/1', value: 2 }]), { a: [1, 2] });
  assert.deepEqual(applyPatch({ a: [1] }, [{ op: 'add', path: '/a/-', value: 2 }]), { a: [1, 2] });
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'add', path: '', value: [1, 2] }]), [1, 2]);
  assert.deepEqual(
    applyPatch({ a: [1] }, [{ op: 'add', path: '/a/0', value: { nested: {} } }]),
    { a: [{ nested: {} }, 1] },
  );
});

test('add: 数组越界与前导零索引被拒绝', () => {
  assert.equal(mustFail({ a: [1] }, [{ op: 'add', path: '/a/5', value: 2 }]).code, 'BAD_ARRAY_INDEX');
  assert.equal(mustFail({ a: [1] }, [{ op: 'add', path: '/a/01', value: 2 }]).code, 'BAD_ARRAY_INDEX');
});

test('remove: 对象属性/数组元素/不存在路径', () => {
  assert.deepEqual(applyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]), { b: 2 });
  assert.deepEqual(applyPatch({ a: [1, 2, 3] }, [{ op: 'remove', path: '/a/0' }]), { a: [2, 3] });
  assert.equal(mustFail({ a: 1 }, [{ op: 'remove', path: '/x' }]).code, 'POINTER_NOT_FOUND');
  assert.equal(mustFail({ a: [1] }, [{ op: 'remove', path: '/a/3' }]).code, 'BAD_ARRAY_INDEX');
});

test('replace: 存在才替换，根文档可整体替换', () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: null }]), { a: null });
  assert.equal(mustFail({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]).code, 'POINTER_NOT_FOUND');
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: 'ok' }]), 'ok');
});

test('move: 移动后插入数组位置重算，禁止移入后代', () => {
  assert.deepEqual(
    applyPatch(
      { a: { x: 1 }, b: [10, 20] },
      [{ op: 'move', from: '/a/x', path: '/b/1' }],
    ),
    { a: {}, b: [10, 1, 20] },
  );
  assert.deepEqual(
    applyPatch({ list: [1, 2, 3] }, [{ op: 'move', from: '/list/2', path: '/list/0' }]),
    { list: [3, 1, 2] },
  );
  const err = mustFail({ a: {} }, [{ op: 'move', from: '/a', path: '/a/child' }]);
  assert.equal(err.code, 'MOVE_INTO_DESCENDANT');
  assert.equal(mustFail({ a: 1 }, [{ op: 'move', from: '/x', path: '/y' }]).code, 'POINTER_NOT_FOUND');
});

test('copy: 深复制，后续修改不影响来源', () => {
  const result = applyPatch(
    { src: { nested: [1, { k: 'v' }] }, dst: [] },
    [
      { op: 'copy', from: '/src', path: '/dst/0' },
      { op: 'replace', path: '/dst/0/nested/1/k', value: 'changed' },
      { op: 'add', path: '/dst/0/nested/-', value: 9 },
    ],
  ) as { src: { nested: unknown[] }; dst: { nested: unknown[] }[] };
  assert.deepEqual(result.src.nested, [1, { k: 'v' }]);
  assert.deepEqual(result.dst[0].nested, [1, { k: 'changed' }, 9]);
});

test('test: 深度相等；null 与缺失不同；失败回定位操作序号', () => {
  const doc = { a: null, b: { c: [1, 2] } };
  applyPatch(doc, [
    { op: 'test', path: '/a', value: null },
    { op: 'test', path: '/b', value: { c: [1, 2] } },
    { op: 'test', path: '', value: doc },
  ]);
  const errMissing = mustFail(doc, [{ op: 'test', path: '/missing', value: null }]);
  assert.equal(errMissing.code, 'TEST_FAILED');
  const errValue = mustFail({ a: 1 }, [
    { op: 'test', path: '/a', value: 1 },
    { op: 'add', path: '/x', value: 1 },
    { op: 'test', path: '/x', value: 2 },
  ]);
  assert.equal(errValue.opIndex, 2);
  assert.equal(errValue.path, '/x');
});

test('JSON Pointer: ~0/~1 转义与对象/数组不混淆', () => {
  const doc = { '~': { 'a/b': 7 }, arr: [1] };
  assert.deepEqual(
    applyPatch(doc, [
      { op: 'test', path: '/~0/a~1b', value: 7 },
      { op: 'replace', path: '/~0/a~1b', value: 8 },
    ]),
    { '~': { 'a/b': 8 }, arr: [1] },
  );
  assert.equal(mustFail({ arr: [1] }, [{ op: 'remove', path: '/arr/length' }]).code, 'BAD_ARRAY_INDEX');
  assert.equal(mustFail({ arr: [1] }, [{ op: 'remove', path: '/arr/foo' }]).code, 'BAD_ARRAY_INDEX');
  assert.equal(mustFail({}, [{ op: 'test', path: 'no-slash', value: 1 }]).code, 'POINTER_INVALID');
  assert.equal(mustFail({}, [{ op: 'test', path: '/a~2', value: 1 }]).code, 'POINTER_INVALID');
});

test('顺序语义: 操作按上一步结果执行；任一失败整组回滚且输入不被修改', () => {
  const input = { list: [1, 2], log: ['a'] };
  const snapshot = structuredClone(input);
  const err = mustFail(input, [
    { op: 'add', path: '/list/-', value: 3 },
    { op: 'copy', from: '/list/2', path: '/log/-' },
    { op: 'remove', path: '/missing' },
  ]);
  assert.equal(err.opIndex, 2);
  assert.deepEqual(input, snapshot);
});

test('原子性: test 失败不留下前面操作的效果（引擎层）', () => {
  const input = { a: 1 };
  const err = mustFail(input, [
    { op: 'add', path: '/b', value: 2 },
    { op: 'test', path: '/a', value: 'wrong' },
  ]);
  assert.equal(err.code, 'TEST_FAILED');
  assert.deepEqual(input, { a: 1 });
});

test('jsonEqual 边界', () => {
  assert.equal(jsonEqual(null, null), true);
  assert.equal(jsonEqual(null, 0), false);
  assert.equal(jsonEqual([1, 2], [1, 2]), true);
  assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(jsonEqual(1, 1.0), true);
});

test('操作形状校验', () => {
  assert.equal(mustFail({}, [{ op: 'frobnicate', path: '/a' }]).code, 'OP_NOT_SUPPORTED');
  assert.equal(mustFail({}, [{ op: 'add', path: '/a' }]).code, 'VALIDATION_ERROR');
  assert.equal(mustFail({}, [{ op: 'move', path: '/a' }]).code, 'VALIDATION_ERROR');
  assert.equal(mustFail({}, 'not-array' as unknown as unknown[]).code, 'VALIDATION_ERROR');
});
