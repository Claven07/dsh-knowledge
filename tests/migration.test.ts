import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const legacySchema = `
  CREATE TABLE knowledge (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'lesson')),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    workspace TEXT NOT NULL CHECK (length(trim(workspace)) > 0),
    project TEXT CHECK (project IS NULL OR length(trim(project)) > 0),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'verified', 'superseded', 'archived')),
    replacement_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (replacement_id) REFERENCES knowledge(id) ON DELETE RESTRICT,
    CHECK (replacement_id IS NULL OR replacement_id <> id),
    CHECK (status <> 'superseded' OR replacement_id IS NOT NULL),
    CHECK (status NOT IN ('candidate', 'verified') OR replacement_id IS NULL)
  );
  CREATE TABLE knowledge_evidence (
    knowledge_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    type TEXT NOT NULL CHECK (type IN ('session', 'file', 'git')),
    source TEXT NOT NULL CHECK (length(trim(source)) > 0),
    locator TEXT,
    timestamp TEXT NOT NULL,
    PRIMARY KEY (knowledge_id, ordinal),
    FOREIGN KEY (knowledge_id) REFERENCES knowledge(id) ON DELETE CASCADE
  );
  CREATE INDEX knowledge_workspace_project_idx ON knowledge(workspace, project);
  CREATE INDEX knowledge_project_idx ON knowledge(project);
  CREATE INDEX knowledge_type_idx ON knowledge(type);
  CREATE INDEX knowledge_status_idx ON knowledge(status);
  CREATE INDEX knowledge_updated_at_idx ON knowledge(updated_at);
`;

describe("SQLite schema migrations", () => {
  let directory: string | undefined;
  let store: KnowledgeStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("preserves knowledge, evidence order, constraints, indexes, and foreign keys", () => {
    directory = mkdtempSync(join(tmpdir(), "dsh-knowledge-v1-migration-"));
    const path = join(directory, "knowledge.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(legacySchema);
    legacy.pragma("user_version = 1");
    legacy.prepare(`
      INSERT INTO knowledge
        (id, type, content, workspace, project, status, replacement_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      "legacy-item", "decision", "Use transactions for storage.", "workspace-a", "project-a",
      "verified", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z",
    );
    const addEvidence = legacy.prepare(`
      INSERT INTO knowledge_evidence (knowledge_id, ordinal, type, source, locator, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    addEvidence.run("legacy-item", 0, "file", "src/store.ts", "transaction", "2025-01-01T00:00:00.000Z");
    addEvidence.run("legacy-item", 1, "session", "session-1", null, "2025-01-02T00:00:00.000Z");
    legacy.close();

    store = new KnowledgeStore(path);
    const repository = new KnowledgeRepository(store);
    const item = repository.getById("legacy-item");
    expect(item).toEqual({
      id: "legacy-item",
      type: "decision",
      content: "Use transactions for storage.",
      scope: { workspace: "workspace-a", project: "project-a" },
      status: "verified",
      creationOrigin: "explicit",
      evidence: [
        {
          type: "file",
          source: "src/store.ts",
          locator: "transaction",
          timestamp: "2025-01-01T00:00:00.000Z",
        },
        {
          type: "session",
          source: "session-1",
          timestamp: "2025-01-02T00:00:00.000Z",
        },
      ],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });
    expect(store.database.pragma("user_version", { simple: true })).toBe(3);
    expect(store.database.prepare("PRAGMA foreign_key_list(knowledge_evidence)").all()).toHaveLength(1);
    expect((store.database.prepare("PRAGMA index_list(knowledge)").all() as Array<{ name: string }>)
      .map(({ name }) => name)).toEqual(expect.arrayContaining([
      "knowledge_workspace_project_idx",
      "knowledge_project_idx",
      "knowledge_type_idx",
      "knowledge_status_idx",
      "knowledge_updated_at_idx",
    ]));

    expect(() => store.database.prepare(`
      INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, timestamp, git_commit, git_path)
      VALUES ('legacy-item', 2, 'file', 'x.ts', '2025-01-03T00:00:00.000Z', ?, NULL)
    `).run("a".repeat(40))).toThrow(/CHECK constraint failed/);
    expect(() => store.database.prepare(`
      INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, timestamp)
      VALUES ('legacy-item', 0, 'file', 'duplicate.ts', '2025-01-03T00:00:00.000Z')
    `).run()).toThrow(/UNIQUE constraint failed/);
    expect(() => store.database.prepare(`
      INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, timestamp)
      VALUES ('legacy-item', -1, 'unknown', 'bad.ts', '2025-01-03T00:00:00.000Z')
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => store.database.prepare(`
      INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, timestamp)
      VALUES ('missing-item', 0, 'file', 'x.ts', '2025-01-03T00:00:00.000Z')
    `).run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("leaves v1 data and schema intact when the migration cannot rebuild its evidence table", () => {
    directory = mkdtempSync(join(tmpdir(), "dsh-knowledge-v1-rollback-"));
    const path = join(directory, "knowledge.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(legacySchema);
    legacy.exec("CREATE TABLE knowledge_evidence_v2 (reserved TEXT)");
    legacy.pragma("user_version = 1");
    legacy.prepare(`
      INSERT INTO knowledge
        (id, type, content, workspace, project, status, replacement_id, created_at, updated_at)
      VALUES ('preserved', 'fact', 'Keep this row.', 'workspace', NULL, 'candidate', NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();
    legacy.prepare(`
      INSERT INTO knowledge_evidence (knowledge_id, ordinal, type, source, locator, timestamp)
      VALUES ('preserved', 0, 'file', 'src/kept.ts', NULL, '2025-01-01T00:00:00.000Z')
    `).run();
    legacy.close();

    expect(() => new KnowledgeStore(path)).toThrow(/already exists/);

    const reopened = new Database(path);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(1);
      expect(reopened.prepare("SELECT content FROM knowledge WHERE id = 'preserved'").get())
        .toEqual({ content: "Keep this row." });
      expect(reopened.prepare("SELECT source, ordinal FROM knowledge_evidence WHERE knowledge_id = 'preserved'").get())
        .toEqual({ source: "src/kept.ts", ordinal: 0 });
      const evidenceColumns = reopened.prepare("PRAGMA table_info(knowledge_evidence)").all() as Array<{ name: string }>;
      expect(evidenceColumns.map(({ name }) => name)).not.toContain("git_commit");
    } finally {
      reopened.close();
    }
  });

  it("migrates a schema v2 database without changing knowledge or provenance", () => {
    directory = mkdtempSync(join(tmpdir(), "dsh-knowledge-v2-migration-"));
    const path = join(directory, "knowledge.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(legacySchema);
    legacy.exec("ALTER TABLE knowledge_evidence ADD COLUMN git_commit TEXT;");
    legacy.exec("ALTER TABLE knowledge_evidence ADD COLUMN git_path TEXT;");
    legacy.pragma("user_version = 2");
    legacy.prepare(`
      INSERT INTO knowledge
        (id, type, content, workspace, project, status, replacement_id, created_at, updated_at)
      VALUES ('v2-item', 'lesson', 'Use bounded startup waits.', 'workspace-v2', 'api', 'candidate', NULL, '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z')
    `).run();
    legacy.prepare(`
      INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, locator, timestamp, git_commit, git_path)
      VALUES ('v2-item', 0, 'file', 'src/startup.ts', 'initialize', '2025-02-01T00:00:00.000Z', ?, ?)
    `).run("a".repeat(40), "src/startup.ts");
    legacy.close();

    store = new KnowledgeStore(path);
    const repository = new KnowledgeRepository(store);
    expect(repository.getById("v2-item")).toEqual({
      id: "v2-item",
      type: "lesson",
      content: "Use bounded startup waits.",
      scope: { workspace: "workspace-v2", project: "api" },
      status: "candidate",
      creationOrigin: "explicit",
      evidence: [{
        type: "file",
        source: "src/startup.ts",
        locator: "initialize",
        timestamp: "2025-02-01T00:00:00.000Z",
        gitProvenance: { commit: "a".repeat(40), path: "src/startup.ts" },
      }],
      createdAt: "2025-02-01T00:00:00.000Z",
      updatedAt: "2025-02-01T00:00:00.000Z",
    });
    expect(store.database.pragma("user_version", { simple: true })).toBe(3);
    expect((store.database.prepare("PRAGMA index_list(knowledge)").all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(["knowledge_workspace_project_idx", "knowledge_origin_scope_status_idx"]));

    expect(() => store.database.prepare(`
      INSERT INTO knowledge
        (id, type, content, workspace, project, status, created_at, updated_at, creation_origin)
      VALUES ('bad-origin', 'fact', 'Bad origin value.', 'workspace-v2', NULL, 'candidate', '2025-02-01', '2025-02-01', 'automatic-ish')
    `).run()).toThrow(/CHECK constraint failed/);
  });
});
