import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store } from './store.js';
import { createApp } from './server.js';
import { Server } from 'node:http';

const dir = join(tmpdir(), `jsonpatch-api-${process.pid}`);
let store: Store;
let server: Server;
let base: string;

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  store = new Store(join(dir, 'api.db'));
  server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('完整 API 流程: 创建→预览不落地→提交→取版本→修订记录→导出', async () => {
  const created = await call('POST', '/documents', { name: 'api-doc', content: { list: [1, 2], x: null } });
  assert.equal(created.status, 201);

  const preview = await call('POST', '/documents/api-doc/preview', {
    base_version: 1,
    patch: [{ op: 'add', path: '/list/0', value: 0 }],
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.content, { list: [0, 1, 2], x: null });

  const stillV1 = await call('GET', '/documents/api-doc');
  assert.equal(stillV1.json.latest_version, 1);

  const committed = await call('POST', '/documents/api-doc/commits', {
    base_version: 1,
    patch: [{ op: 'add', path: '/list/0', value: 0 }],
  });
  assert.equal(committed.status, 201);
  assert.equal(committed.json.version, 2);

  const v1 = await call('GET', '/documents/api-doc/versions/1');
  assert.deepEqual(v1.json.content, { list: [1, 2], x: null });

  const revisions = await call('GET', '/documents/api-doc/revisions');
  assert.equal(revisions.json.revisions.length, 2);

  const exported = await call('GET', '/documents/api-doc/export?version=2');
  assert.deepEqual(exported.json.content, { list: [0, 1, 2], x: null });
});

test('失败补丁: 422 携带操作序号/路径/原因，并记录失败且不升版本', async () => {
  await call('POST', '/documents', { name: 'fail-doc', content: { a: 1 } });
  const res = await call('POST', '/documents/fail-doc/commits', {
    base_version: 1,
    patch: [
      { op: 'add', path: '/b', value: 2 },
      { op: 'test', path: '/a', value: 'wrong' },
    ],
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'TEST_FAILED');
  assert.equal(res.json.error.op_index, 1);
  assert.equal(res.json.error.path, '/a');

  const doc = await call('GET', '/documents/fail-doc');
  assert.equal(doc.json.latest_version, 1);
  assert.deepEqual(doc.json.content, { a: 1 });

  const revisions = await call('GET', '/documents/fail-doc/revisions');
  assert.equal(revisions.json.revisions.length, 2);
  assert.equal(revisions.json.revisions[1].success, 0);
});

test('版本冲突: 基础版本变化返回 409', async () => {
  await call('POST', '/documents', { name: 'conflict-doc', content: { n: 1 } });
  const ok = await call('POST', '/documents/conflict-doc/commits', {
    base_version: 1,
    patch: [{ op: 'replace', path: '/n', value: 2 }],
  });
  assert.equal(ok.json.version, 2);
  const stale = await call('POST', '/documents/conflict-doc/commits', {
    base_version: 1,
    patch: [{ op: 'replace', path: '/n', value: 3 }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.json.error.current_version, 2);
});

test('参数校验与 404', async () => {
  const badJson = await fetch(base + '/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);

  const noName = await call('POST', '/documents', { content: {} });
  assert.equal(noName.status, 400);

  const missing = await call('GET', '/documents/no-such-doc');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  const badBase = await call('POST', '/documents/conflict-doc/preview', {
    base_version: 'abc',
    patch: [],
  });
  assert.equal(badBase.status, 400);
});

test('null 与缺失区分、数组边界错误信息', async () => {
  await call('POST', '/documents', { name: 'null-doc', content: { a: null } });
  const missingTest = await call('POST', '/documents/null-doc/commits', {
    base_version: 1,
    patch: [{ op: 'test', path: '/b', value: null }],
  });
  assert.equal(missingTest.status, 422);
  assert.equal(missingTest.json.error.code, 'TEST_FAILED');

  const oob = await call('POST', '/documents/null-doc/commits', {
    base_version: 1,
    patch: [{ op: 'add', path: '/a/0', value: 1 }],
  });
  assert.equal(oob.status, 422);
});
