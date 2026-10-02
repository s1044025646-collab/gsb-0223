import { PatchError } from './errors.js';
import {
  deepClone,
  getValue,
  hasValue,
  JsonValue,
  parsePointer,
  resolveTarget,
  Target,
} from './pointer.js';

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: JsonValue;
  from?: string;
}

const VALID_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

export function validateOperationShape(op: unknown, index: number): asserts op is PatchOperation {
  const pathOf = (o: Record<string, unknown>): string =>
    typeof o.path === 'string' ? (o.path as string) : '';
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new PatchError('VALIDATION_ERROR', `操作 #${index} 必须是对象`, index, '');
  }
  const o = op as Record<string, unknown>;
  if (typeof o.op !== 'string' || !VALID_OPS.has(o.op)) {
    throw new PatchError(
      'OP_NOT_SUPPORTED',
      `操作 #${index} 的 op 无效，仅支持 add/remove/replace/move/copy/test`,
      index,
      pathOf(o),
    );
  }
  if (typeof o.path !== 'string') {
    throw new PatchError('VALIDATION_ERROR', `操作 #${index} 缺少字符串类型的 path`, index, '');
  }
  if ((o.op === 'move' || o.op === 'copy') && typeof o.from !== 'string') {
    throw new PatchError('VALIDATION_ERROR', `操作 #${index} (${o.op}) 缺少字符串类型的 from`, index, o.path);
  }
  if ((o.op === 'add' || o.op === 'replace' || o.op === 'test') && !('value' in o)) {
    throw new PatchError('VALIDATION_ERROR', `操作 #${index} (${o.op}) 缺少 value`, index, o.path);
  }
  parsePointerShallow(o.path, index);
  if (typeof o.from === 'string') parsePointerShallow(o.from, index, true);
}

function parsePointerShallow(pointer: string, index: number, isFrom = false): void {
  if (pointer === '') return;
  if (pointer[0] !== '/') {
    throw new PatchError(
      'POINTER_INVALID',
      `非法 JSON Pointer: "${pointer}"，非空指针必须以 / 开头`,
      index,
      isFrom ? '' : pointer,
    );
  }
  if (pointer.includes('~') && /~[^01]/.test(pointer)) {
    throw new PatchError('POINTER_INVALID', `非法转义序列（仅允许 ~0 与 ~1）: "${pointer}"`, index, pointer);
  }
}

function applyAdd(root: JsonValue, target: Target, value: JsonValue): JsonValue {
  if (target.kind === 'root') return value;
  if (target.kind === 'array') {
    target.parent.splice(target.key, 0, value);
    return root;
  }
  target.parent[target.key] = value;
  return root;
}

function applyRemove(root: JsonValue, target: Target, index: number, path: string): JsonValue {
  if (target.kind === 'root') {
    throw new PatchError('VALIDATION_ERROR', '不能对根文档执行 remove（根必须保留为 JSON 值）', index, path);
  }
  if (!target.exists) {
    if (target.kind === 'array') {
      throw new PatchError('POINTER_NOT_FOUND', '数组索引越界，无可删除元素', index, path);
    }
    throw new PatchError('POINTER_NOT_FOUND', `属性 "${target.key}" 不存在，无法删除`, index, path);
  }
  if (target.kind === 'array') {
    target.parent.splice(target.key, 1);
  } else {
    delete target.parent[target.key];
  }
  return root;
}

function isPrefixOf(fromTokens: string[], pathTokens: string[]): boolean {
  if (fromTokens.length >= pathTokens.length) return false;
  return fromTokens.every((token, i) => token === pathTokens[i]);
}

export function applyPatch(input: JsonValue, operations: unknown[]): JsonValue {
  if (!Array.isArray(operations)) {
    throw new PatchError('VALIDATION_ERROR', '补丁必须是操作对象数组', -1, '');
  }
  let working = deepClone(input);

  for (let i = 0; i < operations.length; i++) {
    validateOperationShape(operations[i], i);
    const op = operations[i] as PatchOperation;
    try {
      switch (op.op) {
        case 'add': {
          const target = resolveTarget(working, op.path, i);
          const afterAdd = applyAdd(working, target, deepClone(op.value as JsonValue));
          working = afterAdd;
          break;
        }
        case 'remove': {
          const target = resolveTarget(working, op.path, i);
          applyRemove(working, target, i, op.path);
          break;
        }
        case 'replace': {
          const target = resolveTarget(working, op.path, i);
          if (target.kind !== 'root' && !target.exists) {
            throw new PatchError('POINTER_NOT_FOUND', 'replace 要求目标路径必须存在', i, op.path);
          }
          if (target.kind === 'root') {
            return deepClone(op.value as JsonValue);
          }
          if (target.kind === 'array') {
            target.parent[target.key] = deepClone(op.value as JsonValue);
          } else {
            target.parent[target.key] = deepClone(op.value as JsonValue);
          }
          break;
        }
        case 'move': {
          if (!hasValue(working, op.from as string)) {
            throw new PatchError('POINTER_NOT_FOUND', `move 的 from 路径不存在: ${op.from}`, i, op.path, op.from);
          }
          const fromTokens = parsePointer(op.from as string);
          const pathTokens = parsePointer(op.path);
          if (isPrefixOf(fromTokens, pathTokens)) {
            throw new PatchError(
              'MOVE_INTO_DESCENDANT',
              '不能将位置移动到其自身的后代路径',
              i,
              op.path,
              op.from,
            );
          }
          const value = deepClone(getValue(working, op.from as string));
          const removeTarget = resolveTarget(working, op.from as string, i);
          applyRemove(working, removeTarget, i, op.from as string);
          const addTarget = resolveTarget(working, op.path, i);
          applyAdd(working, addTarget, value);
          break;
        }
        case 'copy': {
          if (!hasValue(working, op.from as string)) {
            throw new PatchError('POINTER_NOT_FOUND', `copy 的 from 路径不存在: ${op.from}`, i, op.path, op.from);
          }
          const value = deepClone(getValue(working, op.from as string));
          const addTarget = resolveTarget(working, op.path, i);
          applyAdd(working, addTarget, value);
          break;
        }
        case 'test': {
          if (!hasValue(working, op.path)) {
            throw new PatchError('TEST_FAILED', `test 路径不存在（与 null 不同）: ${op.path}`, i, op.path);
          }
          const actual = getValue(working, op.path);
          if (!jsonEqual(actual, op.value as JsonValue)) {
            throw new PatchError(
              'TEST_FAILED',
              `test 失败：当前值 ${JSON.stringify(actual)} 不等于预期 ${JSON.stringify(op.value)}`,
              i,
              op.path,
            );
          }
          break;
        }
      }
    } catch (err) {
      if (err instanceof PatchError) throw err;
      throw new PatchError(
        'INTERNAL_ERROR',
        err instanceof Error ? err.message : String(err),
        i,
        op.path,
        op.from,
      );
    }
  }
  return working;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
