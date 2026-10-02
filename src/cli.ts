import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError, PatchError } from './errors.js';
import { JsonValue } from './pointer.js';
import { applyPatch, PatchOperation } from './patch.js';
import { Store } from './store.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  return { command: command ?? 'help', positional, options };
}

function readJsonInput(value?: string, file?: string): JsonValue | PatchOperation[] {
  let raw: string;
  if (file) {
    raw = readFileSync(resolve(file), 'utf-8');
  } else if (value !== undefined) {
    raw = value;
  } else {
    throw new ApiError('VALIDATION_ERROR', 400, '需要通过位置参数或 --file 提供 JSON');
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (err) {
    throw new ApiError('INVALID_JSON', 400, `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function out(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function fail(err: unknown): never {
  if (err instanceof ApiError || err instanceof PatchError) {
    process.stderr.write(
      JSON.stringify(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err instanceof PatchError
              ? { op_index: err.opIndex, path: err.path, ...(err.from ? { from: err.from } : {}) }
              : err.details ?? {}),
          },
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(1);
  }
  process.stderr.write(String(err) + '\n');
  process.exit(1);
}

function resolveDoc(store: Store, key: string): { id: string; name: string } {
  const byName = store.getDocumentByName(key);
  if (byName) return { id: byName.id, name: byName.name };
  const byId = store.getDocumentById(key);
  if (byId) return { id: byId.id, name: byId.name };
  throw new ApiError('NOT_FOUND', 404, `文档 "${key}" 不存在`);
}

const HELP = `json-patch 本地文档修订 CLI

用法:
  json-patch create <名称> <初始JSON | --file 文件>
  json-patch get <名称|ID>
  json-patch version <名称|ID> <版本号>
  json-patch revisions <名称|ID>
  json-patch preview <名称|ID> --base <版本号> <补丁JSON数组 | --file 文件>
  json-patch commit <名称|ID> --base <版本号> <补丁JSON数组 | --file 文件>
  json-patch export <名称|ID> [--version <版本号>]

通用选项:
  --data-dir <目录>   SQLite 数据目录（默认 ./data，或环境变量 JSONPATCH_DATA_DIR）
  --file <路径>       从文件读取 JSON 参数
  --help              显示帮助

示例:
  json-patch create demo "{\\"list\\":[1,2]}"
  json-patch commit demo --base 1 "[{\\"op\\":\\"add\\",\\"path\\":\\"/list/0\\",\\"value\\":0}]"
`;

export function runCli(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.command === 'help' || args.options.help) {
    process.stdout.write(HELP);
    return;
  }

  const dataDir = args.options['data-dir'] ?? process.env.JSONPATCH_DATA_DIR ?? resolve(process.cwd(), 'data');
  const store = new Store(resolve(dataDir, 'jsonpatch.db'));

  try {
    switch (args.command) {
      case 'create': {
        const name = args.positional[0];
        if (!name) throw new ApiError('VALIDATION_ERROR', 400, '缺少文档名称');
        const jsonArg = args.positional[1];
        const content = readJsonInput(jsonArg, args.options.file) as JsonValue;
        if (store.getDocumentByName(name)) {
          throw new ApiError('DOC_EXISTS', 409, `文档名 "${name}" 已存在`);
        }
        const id = randomUUID();
        const { version } = store.createDocument(id, name, content);
        out({ id, name, version, content });
        break;
      }
      case 'get': {
        const doc = resolveDoc(store, args.positional[0] ?? '');
        const meta = store.getDocumentById(doc.id)!;
        const latest = store.getLatestContent(doc.id);
        out({ id: meta.id, name: meta.name, latest_version: latest.version, content: latest.content });
        break;
      }
      case 'version': {
        const doc = resolveDoc(store, args.positional[0] ?? '');
        const version = Number(args.positional[1]);
        if (!Number.isInteger(version) || version < 1) {
          throw new ApiError('VALIDATION_ERROR', 400, '版本号必须是正整数');
        }
        const rev = store.getRevision(doc.id, version);
        out({
          version: rev.version,
          base_version: rev.base_version,
          patch: rev.patch,
          content: rev.content,
          created_at: rev.created_at,
        });
        break;
      }
      case 'revisions': {
        const doc = resolveDoc(store, args.positional[0] ?? '');
        out({ name: doc.name, revisions: store.listRevisions(doc.id) });
        break;
      }
      case 'preview':
      case 'commit': {
        const doc = resolveDoc(store, args.positional[0] ?? '');
        const base = Number(args.options.base);
        if (!Number.isInteger(base) || base < 1) {
          throw new ApiError('VALIDATION_ERROR', 400, '--base 必须是正整数版本号');
        }
        const patch = readJsonInput(args.positional[1], args.options.file) as PatchOperation[];
        if (!Array.isArray(patch)) {
          throw new ApiError('VALIDATION_ERROR', 400, '补丁必须是操作数组');
        }
        const latest = store.getLatestContent(doc.id);
        if (latest.version !== base) {
          throw new ApiError(
            'VERSION_CONFLICT',
            409,
            `版本冲突：期望基础版本 ${base}，当前最新版本为 ${latest.version}`,
            { expected_base_version: base, current_version: latest.version },
          );
        }
        let result: JsonValue;
        try {
          result = applyPatch(latest.content, patch as unknown[]);
        } catch (err) {
          if (err instanceof PatchError && args.command === 'commit') {
            store.recordFailure(doc.id, patch, err.code, err.message, err.opIndex, err.path);
          }
          throw err;
        }
        if (args.command === 'preview') {
          out({ base_version: base, would_become_version: base + 1, content: result });
        } else {
          const newVersion = store.commitPatch(doc.id, base, patch, result);
          out({ version: newVersion, content: result });
        }
        break;
      }
      case 'export': {
        const doc = resolveDoc(store, args.positional[0] ?? '');
        const version = args.options.version
          ? Number(args.options.version)
          : store.getLatestContent(doc.id).version;
        const rev = store.getRevision(doc.id, version);
        out({ name: doc.name, version: rev.version, content: rev.content });
        break;
      }
      default:
        throw new ApiError('NOT_FOUND', 400, `未知命令: ${args.command}（使用 --help 查看用法）`);
    }
  } catch (err) {
    fail(err);
  } finally {
    store.close();
  }
}
