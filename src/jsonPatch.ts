export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PatchOperationName = "add" | "remove" | "replace" | "move" | "copy" | "test";

export interface PatchOperation {
  op: PatchOperationName;
  path: string;
  from?: string;
  value?: JsonValue;
}

export interface PatchErrorDetails {
  index: number;
  path?: string;
  reason: string;
  code:
    | "INVALID_OPERATION"
    | "INVALID_POINTER"
    | "POINTER_NOT_FOUND"
    | "TYPE_MISMATCH"
    | "INVALID_ARRAY_INDEX"
    | "TEST_FAILED"
    | "INVALID_MOVE";
}

export class JsonPatchError extends Error {
  details: PatchErrorDetails;

  constructor(details: PatchErrorDetails) {
    super(details.reason);
    this.name = "JsonPatchError";
    this.details = details;
  }
}

type Container = JsonValue[] | { [key: string]: JsonValue };

interface Reference {
  parent: Container;
  key: string | number;
}

export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new JsonPatchError({
      index: -1,
      path: pointer,
      reason: "JSON Pointer 必须为空字符串或以 / 开头",
      code: "INVALID_POINTER",
    });
  }
  return pointer.slice(1).split("/").map((token) => {
    if (/~(?![01])/.test(token)) {
      throw new JsonPatchError({
        index: -1,
        path: pointer,
        reason: "JSON Pointer 中的转义必须是 ~0 或 ~1",
        code: "INVALID_POINTER",
      });
    }
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function deepClone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
}

function fail(index: number, path: string | undefined, reason: string, code: PatchErrorDetails["code"]): never {
  throw new JsonPatchError({ index, path, reason, code });
}

function isArrayIndexToken(token: string): boolean {
  return token === "0" || /^[1-9][0-9]*$/.test(token);
}

function findValue(document: JsonValue, tokens: string[], pointer: string): { found: true; value: JsonValue } | { found: false } {
  let current: JsonValue = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!isArrayIndexToken(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false };
      current = current[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function resolveParent(document: JsonValue, pointer: string, forAdd: boolean, index: number): Reference {
  const tokens = parseJsonPointer(pointer);
  if (tokens.length === 0) {
    fail(index, pointer, "根节点没有可定位的父对象", "INVALID_POINTER");
  }
  const childToken = tokens.pop()!;
  const parentResult = findValue(document, tokens, pointer);
  if (!parentResult.found) {
    fail(index, pointer, "父路径不存在", "POINTER_NOT_FOUND");
  }
  const parent = parentResult.value;
  if (Array.isArray(parent)) {
    if (childToken === "-") {
      if (!forAdd) fail(index, pointer, "路径 - 只表示数组末尾，不能读取、替换或删除", "INVALID_ARRAY_INDEX");
      return { parent, key: parent.length };
    }
    if (!isArrayIndexToken(childToken)) {
      fail(index, pointer, "数组下标必须是 0 或无前导零的非负整数", "INVALID_ARRAY_INDEX");
    }
    const arrayIndex = Number(childToken);
    const limit = forAdd ? parent.length : parent.length - 1;
    if (arrayIndex > limit) {
      fail(index, pointer, forAdd ? "数组插入位置越界" : "数组下标越界", "INVALID_ARRAY_INDEX");
    }
    return { parent, key: arrayIndex };
  }
  if (parent !== null && typeof parent === "object") {
    return { parent, key: childToken };
  }
  fail(index, pointer, "路径父级既不是对象也不是数组", "TYPE_MISMATCH");
}

function getExistingValue(document: JsonValue, pointer: string, index: number): JsonValue {
  const tokens = parseJsonPointer(pointer);
  const result = findValue(document, tokens, pointer);
  if (!result.found) {
    fail(index, pointer, "路径不存在；null 是存在的值，不等同于缺失", "POINTER_NOT_FOUND");
  }
  return result.value;
}

function addValue(document: JsonValue, pointer: string, value: JsonValue, index: number): JsonValue {
  if (pointer === "") return deepClone(value);
  const ref = resolveParent(document, pointer, true, index);
  if (Array.isArray(ref.parent)) {
    ref.parent.splice(ref.key as number, 0, deepClone(value));
  } else {
    ref.parent[ref.key as string] = deepClone(value);
  }
  return document;
}

function removeValue(document: JsonValue, pointer: string, index: number): JsonValue {
  if (pointer === "") return null;
  const ref = resolveParent(document, pointer, false, index);
  if (Array.isArray(ref.parent)) {
    ref.parent.splice(ref.key as number, 1);
  } else {
    delete ref.parent[ref.key as string];
  }
  return document;
}

function replaceValue(document: JsonValue, pointer: string, value: JsonValue, index: number): JsonValue {
  getExistingValue(document, pointer, index);
  if (pointer === "") return deepClone(value);
  const ref = resolveParent(document, pointer, false, index);
  if (Array.isArray(ref.parent)) ref.parent[ref.key as number] = deepClone(value);
  else ref.parent[ref.key as string] = deepClone(value);
  return document;
}

function assertOperationShape(operation: unknown, index: number): asserts operation is PatchOperation {
  if (operation === null || typeof operation !== "object" || Array.isArray(operation)) {
    fail(index, undefined, "每个补丁操作必须是对象", "INVALID_OPERATION");
  }
  const candidate = operation as Record<string, unknown>;
  if (!["add", "remove", "replace", "move", "copy", "test"].includes(String(candidate.op))) {
    fail(index, candidate.path === undefined ? undefined : String(candidate.path), "op 必须是 add、remove、replace、move、copy 或 test", "INVALID_OPERATION");
  }
  if (typeof candidate.path !== "string") {
    fail(index, undefined, "path 必须是字符串", "INVALID_OPERATION");
  }
  if (["move", "copy"].includes(String(candidate.op)) && typeof candidate.from !== "string") {
    fail(index, candidate.path, "move 和 copy 必须提供字符串 from", "INVALID_OPERATION");
  }
  if (["add", "replace", "test"].includes(String(candidate.op)) && !("value" in candidate)) {
    fail(index, candidate.path, `${String(candidate.op)} 操作必须提供 value`, "INVALID_OPERATION");
  }
}

function isPrefixPath(from: string, path: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

export function applyPatch(input: JsonValue, operations: unknown[]): JsonValue {
  if (!Array.isArray(operations)) {
    fail(-1, undefined, "补丁必须是操作数组", "INVALID_OPERATION");
  }
  let document = deepClone(input);
  operations.forEach((operation, index) => {
    assertOperationShape(operation, index);
    try {
      switch (operation.op) {
        case "add":
          document = addValue(document, operation.path, operation.value!, index);
          break;
        case "remove":
          document = removeValue(document, operation.path, index);
          break;
        case "replace":
          document = replaceValue(document, operation.path, operation.value!, index);
          break;
        case "move": {
          if (isPrefixPath(operation.from!, operation.path)) {
            fail(index, operation.path, "不能把位置移动到其自身或其子路径", "INVALID_MOVE");
          }
          const value = getExistingValue(document, operation.from!, index);
          document = removeValue(document, operation.from!, index);
          document = addValue(document, operation.path, value, index);
          break;
        }
        case "copy": {
          const value = getExistingValue(document, operation.from!, index);
          document = addValue(document, operation.path, deepClone(value), index);
          break;
        }
        case "test": {
          const actual = getExistingValue(document, operation.path, index);
          if (!deepEqual(actual, operation.value!)) {
            fail(index, operation.path, "test 操作的期望值与当前值不一致", "TEST_FAILED");
          }
          break;
        }
      }
    } catch (error) {
      if (error instanceof JsonPatchError) {
        if (error.details.index < 0) error.details.index = index;
        throw error;
      }
      throw error;
    }
  });
  return document;
}

export function previewPatch(input: JsonValue, operations: unknown[]): JsonValue {
  return applyPatch(input, operations);
}
