#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./http.js";
import type { JsonValue, PatchOperation } from "./jsonPatch.js";
import { PatchService } from "./store.js";

interface CliOptions {
  command: string;
  values: Map<string, string>;
  json: unknown;
}

function parseArgs(argv: string[]): CliOptions {
  const [command = "", ...rest] = argv;
  const values = new Map<string, string>();
  let jsonText: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--input") {
      jsonText = readFileSync(resolve(rest[++index]), "utf8");
    } else if (token === "--json") {
      jsonText = rest[++index];
    } else if (token.startsWith("--")) {
      values.set(token.slice(2), rest[++index]);
    }
  }
  return {
    command,
    values,
    json: jsonText === undefined ? undefined : JSON.parse(jsonText),
  };
}

function requireValue(options: CliOptions, key: string): string {
  const value = options.values.get(key);
  if (value === undefined) throw new Error(`缺少参数 --${key}`);
  return value;
}

function requireJson<T>(options: CliOptions): T {
  if (options.json === undefined) throw new Error("需要通过 --json 或 --input 提供 JSON");
  return options.json as T;
}

function integer(options: CliOptions, key: string): number {
  const value = Number(requireValue(options, key));
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${key} 必须是非负整数`);
  return value;
}

const options = parseArgs(process.argv.slice(2));
const dbPath = options.values.get("db") ?? resolve("data/json-patch.sqlite");

if (options.command === "serve") {
  const service = new PatchService(dbPath);
  const port = options.values.has("port") ? Number(options.values.get("port")) : 0;
  const server = createApp(service).listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`服务已启动: http://127.0.0.1:${actualPort}`);
    console.log(`数据库: ${dbPath}`);
  });
} else {
  const service = new PatchService(dbPath);
  try {
    const name = requireValue(options, "name");
    let result: unknown;
    switch (options.command) {
      case "create":
        result = service.createDocument(name, requireJson<JsonValue>(options));
        break;
      case "get":
        result = service.getDocument(name);
        break;
      case "version":
        result = service.getVersion(name, integer(options, "version"));
        break;
      case "preview":
      case "commit": {
        const body = requireJson<{ expectedBaseVersion: number; patch: PatchOperation[] }>(options);
        result = options.command === "preview"
          ? service.preview(name, body.expectedBaseVersion, body.patch)
          : service.commit(name, body.expectedBaseVersion, body.patch);
        break;
      }
      case "history":
        result = { revisions: service.history(name) };
        break;
      case "export":
        result = service.exportDocument(name, options.values.has("version") ? integer(options, "version") : undefined);
        break;
      default:
        console.error("可用命令: serve, create, get, version, preview, commit, history, export");
        process.exitCode = 1;
    }
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error instanceof Error && "code" in error ? (error as { code: string }).code : "CLI_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    }, null, 2));
    process.exitCode = 1;
  } finally {
    service.close();
  }
}
