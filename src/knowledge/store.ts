import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

const SCHEMA = `
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

/** Opens a local SQLite database and ensures the storage schema exists. */
export class KnowledgeStore {
  readonly database: Database.Database;
  readonly path: string;

  constructor(path: string) {
    if (path.trim().length === 0) {
      throw new TypeError("Database path must not be empty.");
    }

    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.database = new Database(this.path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("synchronous = NORMAL");
    if (this.path !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
    }

    const currentVersion = this.database.pragma("user_version", {
      simple: true,
    }) as number;

    if (currentVersion > SCHEMA_VERSION) {
      this.database.close();
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`,
      );
    }

    if (currentVersion < SCHEMA_VERSION) {
      try {
        this.database.transaction(() => {
          this.database.exec(SCHEMA);
          this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }
}
