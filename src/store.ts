import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyPatch, type JsonValue, type PatchOperation } from "./jsonPatch.js";

export interface VersionRecord {
  id: number;
  documentName: string;
  version: number;
  content: JsonValue;
  createdAt: string;
}

export interface RevisionRecord {
  version: number;
  patch: PatchOperation[];
  result: JsonValue;
  createdAt: string;
}

export interface PreviewResult {
  baseVersion: number;
  result: JsonValue;
  operationCount: number;
}

export class ConflictError extends Error {
  code = "VERSION_CONFLICT";
  constructor(public currentVersion: number, public expectedBaseVersion: number) {
    super(`预期基础版本 ${expectedBaseVersion}，当前版本已是 ${currentVersion}`);
  }
}

export class NotFoundError extends Error {
  code = "NOT_FOUND";
}

export class DocumentExistsError extends Error {
  code = "DOCUMENT_EXISTS";
}

export class PatchService {
  private db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        name TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        document_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (document_name, version),
        FOREIGN KEY (document_name) REFERENCES documents(name) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        base_version INTEGER NOT NULL,
        patch TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (document_name, version),
        FOREIGN KEY (document_name, version) REFERENCES versions(document_name, version) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS failed_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_name TEXT,
        expected_base_version INTEGER,
        patch TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        failed_index INTEGER,
        failed_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createDocument(name: string, content: JsonValue): VersionRecord {
    if (typeof name !== "string" || name.length === 0 || name.length > 128 || !/^[\w.\-\u4e00-\u9fa5]+$/.test(name)) {
      throw new Error("文档名必须是 1 到 128 个中文、字母、数字、下划线、点或连字符");
    }
    try {
      const insertDocument = this.db.prepare("INSERT INTO documents(name, current_version) VALUES (?, 0)");
      insertDocument.run(name);
    } catch (error) {
      if (isSqliteConstraint(error)) throw new DocumentExistsError(`文档 ${name} 已存在`);
      throw error;
    }
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO versions(document_name, version, content, created_at) VALUES (?, 0, ?, ?)")
      .run(name, JSON.stringify(content), createdAt);
    return { id: 0, documentName: name, version: 0, content, createdAt };
  }

  getDocument(name: string): { name: string; currentVersion: number; content: JsonValue } {
    const row = this.db.prepare(`
      SELECT d.current_version AS currentVersion, v.content AS content
      FROM documents d JOIN versions v
        ON v.document_name = d.name AND v.version = d.current_version
      WHERE d.name = ?
    `).get(name) as { currentVersion: number; content: string } | undefined;
    if (!row) throw new NotFoundError(`文档 ${name} 不存在`);
    return { name, currentVersion: row.currentVersion, content: JSON.parse(row.content) };
  }

  getVersion(name: string, version: number): VersionRecord {
    const row = this.db.prepare(`
      SELECT version, content, created_at AS createdAt
      FROM versions WHERE document_name = ? AND version = ?
    `).get(name, version) as { version: number; content: string; createdAt: string } | undefined;
    if (!row) throw new NotFoundError(`文档 ${name} 的版本 ${version} 不存在`);
    return {
      id: row.version,
      documentName: name,
      version: row.version,
      content: JSON.parse(row.content),
      createdAt: row.createdAt,
    };
  }

  preview(name: string, expectedBaseVersion: number, patch: PatchOperation[]): PreviewResult {
    const base = this.getVersion(name, expectedBaseVersion);
    const result = applyPatch(base.content, patch);
    return { baseVersion: expectedBaseVersion, result, operationCount: patch.length };
  }

  commit(name: string, expectedBaseVersion: number, patch: PatchOperation[]): { version: number; result: JsonValue } {
    const base = this.getVersion(name, expectedBaseVersion);
    const result = applyPatch(base.content, patch);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const document = this.db.prepare("SELECT current_version AS currentVersion FROM documents WHERE name = ?")
        .get(name) as { currentVersion: number } | undefined;
      if (!document) throw new NotFoundError(`文档 ${name} 不存在`);
      if (document.currentVersion !== expectedBaseVersion) {
        throw new ConflictError(document.currentVersion, expectedBaseVersion);
      }
      const nextVersion = expectedBaseVersion + 1;
      const createdAt = new Date().toISOString();
      this.db.prepare("INSERT INTO versions(document_name, version, content, created_at) VALUES (?, ?, ?, ?)")
        .run(name, nextVersion, JSON.stringify(result), createdAt);
      this.db.prepare("INSERT INTO revisions(document_name, version, base_version, patch, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(name, nextVersion, expectedBaseVersion, JSON.stringify(patch), JSON.stringify(result), createdAt);
      this.db.prepare("UPDATE documents SET current_version = ?, updated_at = ? WHERE name = ?")
        .run(nextVersion, createdAt, name);
      this.db.exec("COMMIT");
      return { version: nextVersion, result };
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (!(error instanceof ConflictError)) {
        this.recordFailure(name, expectedBaseVersion, patch, error);
      }
      throw error;
    }
  }

  history(name: string): RevisionRecord[] {
    this.getDocument(name);
    const rows = this.db.prepare(`
      SELECT version, patch, result, created_at AS createdAt
      FROM revisions WHERE document_name = ? ORDER BY version ASC
    `).all(name) as Array<{ version: number; patch: string; result: string; createdAt: string }>;
    return rows.map((row) => ({
      version: row.version,
      patch: JSON.parse(row.patch),
      result: JSON.parse(row.result),
      createdAt: row.createdAt,
    }));
  }

  exportDocument(name: string, version?: number): { name: string; version: number; content: JsonValue } {
    const resolvedVersion = version ?? this.getDocument(name).currentVersion;
    return { name, version: resolvedVersion, content: this.getVersion(name, resolvedVersion).content };
  }

  private recordFailure(name: string | null, expectedBaseVersion: number | null, patch: unknown, error: unknown): void {
    const details = error instanceof Error && "details" in error
      ? (error as { details: { code: string; reason: string; index?: number; path?: string } }).details
      : { code: error instanceof Error ? error.name : "UNKNOWN", reason: error instanceof Error ? error.message : "未知错误" };
    this.db.prepare(`
      INSERT INTO failed_attempts(
        document_name, expected_base_version, patch, error_code, error_message, failed_index, failed_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      expectedBaseVersion,
      JSON.stringify(patch),
      details.code,
      details.reason,
      "index" in details ? details.index ?? null : null,
      "path" in details ? details.path ?? null : null,
    );
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}
