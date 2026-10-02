import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { JsonPatchError, type JsonValue, type PatchOperation } from "./jsonPatch.js";
import { ConflictError, DocumentExistsError, NotFoundError, PatchService } from "./store.js";

interface ParsedRequest {
  pathParts: string[];
  query: URLSearchParams;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) {
        reject(new Error("请求体不能超过 8 MiB"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function requireObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function requireBaseVersion(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.expectedBaseVersion) || (body.expectedBaseVersion as number) < 0) {
    throw new Error("expectedBaseVersion 必须是非负整数");
  }
  return body.expectedBaseVersion as number;
}

function requirePatch(body: Record<string, unknown>): PatchOperation[] {
  if (!Array.isArray(body.patch)) throw new Error("patch 必须是 JSON Patch 操作数组");
  return body.patch as PatchOperation[];
}

function requireContent(body: Record<string, unknown>): JsonValue {
  if (!("content" in body)) throw new Error("content 为必填项");
  return body.content as JsonValue;
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof JsonPatchError) {
    sendJson(response, 422, {
      error: {
        code: error.details.code,
        message: error.details.reason,
        operationIndex: error.details.index,
        path: error.details.path,
      },
    });
    return;
  }
  if (error instanceof ConflictError) {
    sendJson(response, 409, {
      error: {
        code: error.code,
        message: error.message,
        currentVersion: error.currentVersion,
        expectedBaseVersion: error.expectedBaseVersion,
      },
    });
    return;
  }
  if (error instanceof NotFoundError) {
    sendJson(response, 404, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof DocumentExistsError) {
    sendJson(response, 409, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 400, {
    error: { code: "BAD_REQUEST", message: error instanceof Error ? error.message : "请求无效" },
  });
}

export function createApp(service: PatchService): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const parsed: ParsedRequest = {
        pathParts: url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
        query: url.searchParams,
      };
      const method = request.method ?? "GET";
      const [resource, name, subResource, versionText] = parsed.pathParts;

      if (method === "POST" && resource === "documents" && !name) {
        const body = requireObject(await readJson(request));
        if (typeof body.name !== "string" || body.name.length === 0) throw new Error("name 必须是非空字符串");
        const record = service.createDocument(body.name, requireContent(body));
        sendJson(response, 201, record);
        return;
      }

      if (resource !== "documents" || !name) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        return;
      }

      if (method === "GET" && !subResource) {
        sendJson(response, 200, service.getDocument(name));
        return;
      }
      if (method === "GET" && subResource === "export") {
        const version = parsed.query.get("version");
        const versionNumber: number | undefined = version === null ? undefined : Number(version);
        if (version !== null && (versionNumber === undefined || !Number.isInteger(versionNumber) || versionNumber < 0)) {
          throw new Error("version 查询参数必须是非负整数");
        }
        sendJson(response, 200, service.exportDocument(name, versionNumber));
        return;
      }
      if (method === "GET" && subResource === "revisions" && !versionText) {
        sendJson(response, 200, { revisions: service.history(name) });
        return;
      }
      if (method === "GET" && subResource === "versions" && versionText !== undefined) {
        const version = Number(versionText);
        if (!Number.isInteger(version) || version < 0) throw new Error("版本号必须是非负整数");
        sendJson(response, 200, service.getVersion(name, version));
        return;
      }
      if (method === "POST" && (subResource === "preview" || subResource === "commit")) {
        const body = requireObject(await readJson(request));
        const baseVersion = requireBaseVersion(body);
        const patch = requirePatch(body);
        if (subResource === "preview") {
          sendJson(response, 200, service.preview(name, baseVersion, patch));
          return;
        }
        sendJson(response, 201, service.commit(name, baseVersion, patch));
        return;
      }

      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (error) {
      errorResponse(response, error);
    }
  });
}
