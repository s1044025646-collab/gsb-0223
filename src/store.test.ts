import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { ApiError } from './errors.js';
import type { PatchOperation } from './patch.js';

const dir = join(tmpdir(), `jsonpatch-test-${process.pid}`);
const dbPath = join(dir, 'test.db');

function freshStore(): Store {
  return new Store(dbPath);
}

before(() => {
  rmSync(dir, { recursive: true, force: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('创建/版本提交/获取与修订记录', () => {
  const store = freshStore();
  const id = randomUUID();
  store.createDocument(id, 'doc1', { v: 1, tags: ['a'] });
  const patch: PatchOperation[] = [{ op: 'add', path: '/tags/-', value: 'b' }];
  const v2 = store.commitPatch(id, 1, patch, { v: 1, tags: ['a', 'b'] });
  assert.equal(v2, 2);
  const latest = store.getLatestContent(id);
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.content, { v: 1, tags: ['a', 'b'] });
  const v1 = store.getRevision(id, 1);
  assert.deepEqual(v1.content, { v: 1, tags: ['a'] });
  const revisions = store.listRevisions(id);
  assert.equal(revisions.length, 2);
  assert.deepEqual(
    revisions.map((r) => r.version),
    [1, 2],
  );
  store.close();
});

test('版本冲突: 过期 base_version 被拒绝且不产生新版本', () => {
  const store = freshStore();
  const id = randomUUID();
  store.createDocument(id, 'doc-conflict', { n: 1 });
  store.commitPatch(id, 1, [{ op: 'replace', path: '/n', value: 2 }] as PatchOperation[], { n: 2 });
  assert.throws(
    () =>
      store.commitPatch(
        id,
        1,
        [{ op: 'replace', path: '/n', value: 3 }] as PatchOperation[],
        { n: 3 },
      ),
    (err: unknown) => err instanceof ApiError && err.code === 'VERSION_CONFLICT',
  );
  assert.equal(store.getLatestContent(id).version, 2);
  assert.deepEqual(store.getLatestContent(id).content, { n: 2 });
  store.close();
});

test('失败尝试被记录但不增加成功版本号，失败后重查内容不变', () => {
  const store = freshStore();
  const id = randomUUID();
  store.createDocument(id, 'doc-fail', { a: 1 });
  const bad: PatchOperation[] = [
    { op: 'add', path: '/b', value: 2 },
    { op: 'test', path: '/a', value: 999 },
  ];
  store.recordFailure(id, bad, 'TEST_FAILED', 'test 失败', 1, '/a');
  const latest = store.getLatestContent(id);
  assert.equal(latest.version, 1);
  assert.deepEqual(latest.content, { a: 1 });
  const revisions = store.listRevisions(id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].success, 0);
  assert.equal(revisions[1].version, null);
  assert.equal(revisions[1].error_code, 'TEST_FAILED');
  assert.throws(
    () => store.getRevision(id, 2),
    (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND',
  );
  store.close();
});

test('重启持久化: 重新打开数据库可读取旧版本与最新版本', () => {
  let store = freshStore();
  const id = randomUUID();
  store.createDocument(id, 'doc-persist', { n: 0 });
  store.commitPatch(
    id,
    1,
    [{ op: 'replace', path: '/n', value: 1 }] as PatchOperation[],
    { n: 1 },
  );
  store.commitPatch(
    id,
    2,
    [{ op: 'replace', path: '/n', value: 2 }] as PatchOperation[],
    { n: 2 },
  );
  store.close();

  store = freshStore();
  const meta = store.getDocumentByName('doc-persist')!;
  assert.ok(meta);
  assert.deepEqual(store.getLatestContent(meta.id).content, { n: 2 });
  assert.deepEqual(store.getRevision(meta.id, 1).content, { n: 0 });
  assert.deepEqual(store.getRevision(meta.id, 3).content, { n: 2 });
  assert.equal(store.listRevisions(meta.id).length, 3);
  store.close();
});

test('重名文档拒绝', () => {
  const store = freshStore();
  store.createDocument(randomUUID(), 'dup-name', null);
  assert.throws(
    () => store.createDocument(randomUUID(), 'dup-name', null),
    (err: unknown) => err instanceof ApiError && err.code === 'DOC_EXISTS',
  );
  store.close();
});
