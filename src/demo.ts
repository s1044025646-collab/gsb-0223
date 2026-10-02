import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyPatch } from './patch.js';
import type { PatchOperation } from './patch.js';
import { Store } from './store.js';

const dataDir = resolve(process.cwd(), 'data-demo');
if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

const store = new Store(resolve(dataDir, 'jsonpatch.db'));

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function show(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

try {
  step('1. 创建文档 v1（含数组与带斜杠属性 "a/b"）');
  const id = randomUUID();
  const initial = {
    tags: ['x', 'y'],
    meta: { 'a/b': 'slash-key', note: '原始备注' },
    staging: { keep: true },
    n: 1,
  };
  store.createDocument(id, 'demo', initial);
  show('v1', initial);

  step('2. 提交 v2：数组头部插入（后续元素后移）+ 修改带斜杠属性');
  const patchV2: PatchOperation[] = [
    { op: 'add', path: '/tags/0', value: 'first' },
    { op: 'replace', path: '/meta/a~1b', value: 'changed' },
  ];
  const v2 = applyPatch(store.getLatestContent(id).content, patchV2);
  const ver2 = store.commitPatch(id, 1, patchV2, v2);
  show(`v${ver2}`, v2);

  step('3. 提交 v3：move（/meta/note 移到 /archived-note）+ copy + test 条件校验');
  const patchV3: PatchOperation[] = [
    { op: 'move', from: '/meta/note', path: '/archived-note' },
    { op: 'copy', from: '/tags/1', path: '/copied-tag' },
    { op: 'test', path: '/tags/0', value: 'first' },
    { op: 'test', path: '/archived-note', value: '原始备注' },
  ];
  const v3 = applyPatch(store.getLatestContent(id).content, patchV3);
  const ver3 = store.commitPatch(id, 2, patchV3, v3);
  show(`v${ver3}`, v3);

  step('4. 验证 copy 独立性：修改 /copied-tag 不影响来源 /tags/1');
  const patchIndep: PatchOperation[] = [{ op: 'replace', path: '/copied-tag', value: 'MUTATED-COPY' }];
  const afterIndep = applyPatch(store.getLatestContent(id).content, patchIndep);
  show('copied-tag =', (afterIndep as Record<string, unknown>)['copied-tag']);
  show('tags/1 仍为 =', (afterIndep as { tags: string[] }).tags[1]);

  step('5. 故意提交失败补丁：前两步有效，第三步 test 失败 → 整组回滚');
  const badPatch: PatchOperation[] = [
    { op: 'add', path: '/tags/-', value: 'should-rollback' },
    { op: 'remove', path: '/n' },
    { op: 'test', path: '/n', value: 999 },
  ];
  try {
    applyPatch(store.getLatestContent(id).content, badPatch);
    console.log('意外：补丁竟然成功了');
  } catch (err) {
    store.recordFailure(
      id,
      badPatch,
      (err as { code: string }).code,
      (err as Error).message,
      (err as { opIndex: number }).opIndex,
      (err as { path: string }).path,
    );
    console.log(`已拒绝: ${(err as Error).message}`);
  }

  step('6. 回滚后重新查询：最新仍是 v3，内容未变，版本号未增加');
  const latest = store.getLatestContent(id);
  show('最新版本号', latest.version);
  show('最新内容', latest.content);

  step('7. 修订记录（失败尝试 success=0，且不带成功版本号）');
  console.table(store.listRevisions(id));

  step('8. 版本冲突演示：以过期 base_version=1 提交应被拒绝');
  try {
    store.commitPatch(id, 1, [{ op: 'add', path: '/x', value: 1 }] as PatchOperation[], {});
  } catch (err) {
    console.log(`已拒绝: ${(err as Error).message}`);
  }

  console.log(`\n演示数据库位于: ${resolve(dataDir, 'jsonpatch.db')}`);
  console.log('可重启服务后用 CLI 复查，例如: npm run cli -- get demo --data-dir data-demo');
} finally {
  store.close();
}
