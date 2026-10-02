import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError, ErrorCode, PatchError } from './errors.js';
import { JsonValue } from './pointer.js';
import { applyPatch, PatchOperation } from './patch.js';
import { Store } from './store.js';

interface CreateDocBody {
  name?: unknown;
  content?: unknown;
}

interface CommitBody {
  base_version?: unknown;
  patch?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { code, message, ...extra } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 8 * 1024 * 1024) {
      throw new ApiError('VALIDATION_ERROR', 413, '请求体过大（上限 8MB）');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('INVALID_JSON', 400, '请求体不是合法 JSON');
  }
}

function requireDoc(body: Record<string, unknown>): { name: string; content: JsonValue } {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 400, 'name 必须是非空字符串', { field: 'name' });
  }
  if (!/^[\w\-一-龥][\w\-一-龥 .]*$/.test(body.name) || body.name.length > 128) {
    throw new ApiError('VALIDATION_ERROR', 400, 'name 只能包含字母、数字、中文、下划线、连字符，长度不超过 128', {
      field: 'name',
    });
  }
  if (!('content' in body)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'content 必填（可以是任意 JSON 值，包括 null）', { field: 'content' });
  }
  return { name: body.name.trim(), content: body.content as JsonValue };
}

function requireCommitBody(body: Record<string, unknown>): {
  baseVersion: number;
  patch: PatchOperation[];
} {
  if (typeof body.base_version !== 'number' || !Number.isInteger(body.base_version) || body.base_version < 1) {
    throw new ApiError('VALIDATION_ERROR', 400, 'base_version 必须是 >=1 的整数', { field: 'base_version' });
  }
  if (!Array.isArray(body.patch)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'patch 必须是 JSON Patch 操作数组', { field: 'patch' });
  }
  return { baseVersion: body.base_version, patch: body.patch as PatchOperation[] };
}

export function createApp(store: Store): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (method === 'POST' && path === '/documents') {
        const body = (await readJson(req)) as CreateDocBody;
        const { name, content } = requireDoc(body as Record<string, unknown>);
        if (store.getDocumentByName(name)) {
          throw new ApiError('DOC_EXISTS', 409, `文档名 "${name}" 已存在`);
        }
        const id = randomUUID();
        const { version } = store.createDocument(id, name, content);
        sendJson(res, 201, { id, name, version, content });
        return;
      }

      const docMatch = path.match(/^\/documents\/([^/]+)$/);
      const resolveDocId = (key: string): string => {
        const byName = store.getDocumentByName(decodeURIComponent(key));
        if (byName) return byName.id;
        const byId = store.getDocumentById(key);
        if (byId) return byId.id;
        throw new ApiError('NOT_FOUND', 404, `文档 "${key}" 不存在`);
      };

      if (method === 'GET' && docMatch) {
        const docId = resolveDocId(docMatch[1]);
        const meta = store.getDocumentById(docId)!;
        const latest = store.getLatestContent(docId);
        sendJson(res, 200, {
          id: meta.id,
          name: meta.name,
          latest_version: latest.version,
          content: latest.content,
        });
        return;
      }

      const exportMatch = path.match(/^\/documents\/([^/]+)\/export$/);
      if (method === 'GET' && exportMatch) {
        const docId = resolveDocId(exportMatch[1]);
        const meta = store.getDocumentById(docId)!;
        const versionParam = url.searchParams.get('version');
        let version = store.getLatestContent(docId).version;
        if (versionParam !== null) {
          if (!/^\d+$/.test(versionParam)) {
            throw new ApiError('VALIDATION_ERROR', 400, 'version 查询参数必须是正整数');
          }
          version = Number(versionParam);
        }
        const rev = store.getRevision(docId, version);
        sendJson(res, 200, {
          name: meta.name,
          version: rev.version,
          content: rev.content,
        });
        return;
      }

      const revisionsMatch = path.match(/^\/documents\/([^/]+)\/revisions$/);
      if (method === 'GET' && revisionsMatch) {
        const docId = resolveDocId(revisionsMatch[1]);
        const meta = store.getDocumentById(docId)!;
        sendJson(res, 200, { name: meta.name, revisions: store.listRevisions(docId) });
        return;
      }

      const versionMatch = path.match(/^\/documents\/([^/]+)\/versions\/(\d+)$/);
      if (method === 'GET' && versionMatch) {
        const docId = resolveDocId(versionMatch[1]);
        const rev = store.getRevision(docId, Number(versionMatch[2]));
        sendJson(res, 200, {
          version: rev.version,
          base_version: rev.base_version,
          patch: rev.patch,
          content: rev.content,
          created_at: rev.created_at,
        });
        return;
      }

      const previewMatch = path.match(/^\/documents\/([^/]+)\/preview$/);
      if (method === 'POST' && previewMatch) {
        const docId = resolveDocId(previewMatch[1]);
        const body = (await readJson(req)) as CommitBody;
        const { baseVersion, patch } = requireCommitBody(body as Record<string, unknown>);
        const latest = store.getLatestContent(docId);
        if (latest.version !== baseVersion) {
          throw new ApiError(
            'VERSION_CONFLICT',
            409,
            `版本冲突：期望基础版本 ${baseVersion}，当前最新版本为 ${latest.version}`,
            { expected_base_version: baseVersion, current_version: latest.version },
          );
        }
        let result: JsonValue;
        try {
          result = applyPatch(latest.content, patch as unknown[]);
        } catch (err) {
          if (err instanceof PatchError) {
            throw new ApiError(err.code, 422, err.message, {
              op_index: err.opIndex,
              path: err.path,
              from: err.from,
            });
          }
          throw err;
        }
        sendJson(res, 200, {
          base_version: baseVersion,
          would_become_version: baseVersion + 1,
          content: result,
        });
        return;
      }

      const commitMatch = path.match(/^\/documents\/([^/]+)\/commits$/);
      if (method === 'POST' && commitMatch) {
        const docId = resolveDocId(commitMatch[1]);
        const body = (await readJson(req)) as CommitBody;
        const { baseVersion, patch } = requireCommitBody(body as Record<string, unknown>);
        const latest = store.getLatestContent(docId);
        if (latest.version !== baseVersion) {
          throw new ApiError(
            'VERSION_CONFLICT',
            409,
            `版本冲突：期望基础版本 ${baseVersion}，当前最新版本为 ${latest.version}`,
            { expected_base_version: baseVersion, current_version: latest.version },
          );
        }
        let result: JsonValue;
        try {
          result = applyPatch(latest.content, patch as unknown[]);
        } catch (err) {
          if (err instanceof PatchError) {
            try {
              store.recordFailure(docId, patch, err.code, err.message, err.opIndex, err.path);
            } catch {
              // 记录失败不应掩盖原始错误
            }
            throw new ApiError(err.code, 422, err.message, {
              op_index: err.opIndex,
              path: err.path,
              from: err.from,
            });
          }
          throw err;
        }
        const newVersion = store.commitPatch(docId, baseVersion, patch, result);
        sendJson(res, 201, { version: newVersion, content: result });
        return;
      }

      sendError(res, 404, 'NOT_FOUND', `未找到路由: ${method} ${path}`);
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(res, err.status, err.code, err.message, err.details);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'INTERNAL_ERROR', message);
    }
  });
  return server;
}
