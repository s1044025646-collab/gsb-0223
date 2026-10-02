import { PatchError } from './errors.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonContainer = JsonValue[] | { [key: string]: JsonValue };

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parsePointer(pointer: string): string[] {
  if (typeof pointer !== 'string') {
    throw new PatchError('POINTER_INVALID', 'JSON Pointer 必须是字符串', -1, String(pointer));
  }
  if (pointer === '') return [];
  if (pointer[0] !== '/') {
    throw new PatchError('POINTER_INVALID', `非法 JSON Pointer: "${pointer}"，非空指针必须以 / 开头`, -1, pointer);
  }
  return pointer
    .substring(1)
    .split('/')
    .map((raw) => {
      const token = unescapeToken(raw);
      if (/~[^01]/.test(raw)) {
        throw new PatchError('POINTER_INVALID', `非法转义序列: "${raw}"，仅允许 ~0 与 ~1`, -1, pointer);
      }
      return token;
    });
}

function isArrayIndex(token: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(token);
}

function resolveContainer(
  root: JsonValue,
  tokens: string[],
  opIndex: number,
  pointer: string,
):
  | { kind: 'array-target'; target: Extract<Target, { kind: 'array' }> }
  | { kind: 'object-target'; target: Extract<Target, { kind: 'object' }> } {
  let current: JsonValue = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (Array.isArray(current)) {
      if (!isArrayIndex(token) || Number(token) >= current.length) {
        throw new PatchError(
          'POINTER_NOT_FOUND',
          `数组索引 "${token}" 不存在（长度 ${current.length}）`,
          opIndex,
          pointer,
        );
      }
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new PatchError('POINTER_NOT_FOUND', `对象属性 "${token}" 不存在`, opIndex, pointer);
      }
      current = (current as Record<string, JsonValue>)[token];
    } else {
      throw new PatchError(
        'POINTER_PARENT_NOT_FOUND',
        `无法继续访问 "${token}"：当前值不是对象或数组`,
        opIndex,
        pointer,
      );
    }
  }

  const last = tokens[tokens.length - 1];
  if (Array.isArray(current)) {
    if (last === '-') {
      return { kind: 'array-target', target: { kind: 'array', parent: current, key: current.length, exists: false } };
    }
    if (!isArrayIndex(last) || Number(last) > current.length) {
      throw new PatchError(
        'BAD_ARRAY_INDEX',
        `非法数组索引或越界: "${last}"（长度 ${current.length}，允许 0..${current.length}）`,
        opIndex,
        pointer,
      );
    }
    const idx = Number(last);
    return {
      kind: 'array-target',
      target: { kind: 'array', parent: current, key: idx, exists: idx < current.length },
    };
  }
  if (current === null || typeof current !== 'object') {
    throw new PatchError(
      'POINTER_PARENT_NOT_FOUND',
      '路径的父级不是对象或数组',
      opIndex,
      pointer,
    );
  }
  const obj = current as Record<string, JsonValue>;
  return {
    kind: 'object-target',
    target: { kind: 'object', parent: obj, key: last, exists: Object.prototype.hasOwnProperty.call(obj, last) },
  };
}

export function getValue(root: JsonValue, pointer: string): JsonValue {
  const tokens = parsePointer(pointer);
  let current: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!isArrayIndex(token) || Number(token) >= current.length) {
        throw new PatchError(
          'POINTER_NOT_FOUND',
          `数组索引 "${token}" 不存在（长度 ${current.length}）`,
          -1,
          pointer,
        );
      }
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new PatchError('POINTER_NOT_FOUND', `对象属性 "${token}" 不存在`, -1, pointer);
      }
      current = (current as Record<string, JsonValue>)[token];
    } else {
      throw new PatchError('POINTER_NOT_FOUND', `无法在非容器值中访问 "${token}"`, -1, pointer);
    }
  }
  return current;
}

export function hasValue(root: JsonValue, pointer: string): boolean {
  try {
    getValue(root, pointer);
    return true;
  } catch {
    return false;
  }
}

export type Target =
  | { kind: 'root' }
  | { kind: 'array'; parent: JsonValue[]; key: number; exists: boolean }
  | { kind: 'object'; parent: Record<string, JsonValue>; key: string; exists: boolean };

export function resolveTarget(root: JsonValue, pointer: string, opIndex: number): Target {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return { kind: 'root' };
  const resolved = resolveContainer(root, tokens, opIndex, pointer);
  if (resolved.kind === 'array-target') {
    return resolved.target;
  }
  return resolved.target;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
