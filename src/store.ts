import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './errors.js';
import { JsonValue } from './pointer.js';
import { PatchOperation } from './patch.js';

export interface DocumentMeta {
  id: string;
  name: string;
  latest_version: number;
  created_at: string;
}

export interface Revision {
  id: number;
  document_id: string;
  version: number;
  base_version: number | null;
  patch: PatchOperation[] | null;
  content: JsonValue;
  success: number;
  error_code: string | null;
  error_message: string | null;
  error_op_index: number | null;
  error_path: string | null;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL REFERENCES documents(id),
        version INTEGER,
        base_version INTEGER,
        patch TEXT,
        content TEXT NOT NULL,
        success INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_op_index INTEGER,
        error_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(document_id, version);
    `);
  }

  close(): void {
    this.db.close();
  }

  createDocument(id: string, name: string, content: JsonValue): { version: number; revisionId: number } {
    const insDoc = this.db.prepare('INSERT INTO documents (id, name) VALUES (?, ?)');
    const insRev = this.db.prepare(
      `INSERT INTO revisions (document_id, version, base_version, patch, content, success)
       VALUES (?, 1, NULL, NULL, ?, 1)`,
    );
    try {
      this.db.exec('BEGIN IMMEDIATE');
      insDoc.run(id, name);
      const res = insRev.run(id, JSON.stringify(content));
      this.db.exec('COMMIT');
      return { version: 1, revisionId: Number(res.lastInsertRowid) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new ApiError('DOC_EXISTS', 409, `文档名 "${name}" 已存在`);
      }
      throw err;
    }
  }

  getDocumentByName(name: string): DocumentMeta | undefined {
    const row = this.db.prepare('SELECT * FROM documents WHERE name = ?').get(name) as
      | DocumentMeta
      | undefined;
    if (!row) return undefined;
    const latest = this.db
      .prepare('SELECT MAX(version) AS v FROM revisions WHERE document_id = ? AND success = 1')
      .get(name === '' ? '' : row.id) as { v: number };
    return { ...row, latest_version: latest.v };
  }

  getDocumentById(id: string): DocumentMeta | undefined {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentMeta
      | undefined;
    if (!row) return undefined;
    const latest = this.db
      .prepare('SELECT MAX(version) AS v FROM revisions WHERE document_id = ? AND success = 1')
      .get(id) as { v: number };
    return { ...row, latest_version: latest.v };
  }

  getLatestContent(documentId: string): Revision {
    const row = this.db
      .prepare(
        `SELECT * FROM revisions WHERE document_id = ? AND success = 1
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentId) as Revision | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 404, '文档不存在或没有成功版本');
    return this.hydrate(row);
  }

  getRevision(documentId: string, version: number): Revision {
    const row = this.db
      .prepare('SELECT * FROM revisions WHERE document_id = ? AND version = ? AND success = 1')
      .get(documentId, version) as Revision | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 404, `版本 ${version} 不存在`);
    return this.hydrate(row);
  }

  listRevisions(documentId: string): Array<{
    version: number;
    base_version: number | null;
    success: number;
    error_code: string | null;
    created_at: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT version, base_version, success, error_code, created_at
         FROM revisions WHERE document_id = ? ORDER BY id ASC`,
      )
      .all(documentId) as Array<{
      version: number;
      base_version: number | null;
      success: number;
      error_code: string | null;
      created_at: string;
    }>;
    return rows;
  }

  commitPatch(
    documentId: string,
    expectedBaseVersion: number,
    patch: PatchOperation[],
    result: JsonValue,
  ): number {
    const latest = this.getLatestContent(documentId);
    if (latest.version !== expectedBaseVersion) {
      throw new ApiError(
        'VERSION_CONFLICT',
        409,
        `版本冲突：期望基础版本 ${expectedBaseVersion}，当前最新版本为 ${latest.version}`,
        { expected_base_version: expectedBaseVersion, current_version: latest.version },
      );
    }
    const nextVersion = latest.version + 1;
    const ins = this.db.prepare(
      `INSERT INTO revisions (document_id, version, base_version, patch, content, success)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getLatestContent(documentId);
      if (current.version !== expectedBaseVersion) {
        this.db.exec('ROLLBACK');
        throw new ApiError(
          'VERSION_CONFLICT',
          409,
          `版本冲突：期望基础版本 ${expectedBaseVersion}，当前最新版本为 ${current.version}`,
          { expected_base_version: expectedBaseVersion, current_version: current.version },
        );
      }
      ins.run(documentId, nextVersion, expectedBaseVersion, JSON.stringify(patch), JSON.stringify(result));
      this.db.exec('COMMIT');
      return nextVersion;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  recordFailure(
    documentId: string,
    patch: PatchOperation[],
    errorCode: string,
    errorMessage: string,
    errorOpIndex: number,
    errorPath: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO revisions
         (document_id, version, base_version, patch, content, success, error_code, error_message, error_op_index, error_path)
         VALUES (?, NULL, NULL, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        JSON.stringify(patch),
        JSON.stringify(null),
        errorCode,
        errorMessage,
        errorOpIndex,
        errorPath,
      );
  }

  private hydrate(row: Revision): Revision {
    return {
      ...row,
      content: JSON.parse(row.content as unknown as string) as JsonValue,
      patch: row.patch ? (JSON.parse(row.patch as unknown as string) as PatchOperation[]) : null,
    };
  }
}
