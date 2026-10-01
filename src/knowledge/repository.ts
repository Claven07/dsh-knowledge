import { randomUUID } from "node:crypto";
import type {
  CreateKnowledgeInput,
  Evidence,
  EvidenceType,
  Knowledge,
  KnowledgeListOptions,
  KnowledgePatch,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from "./types.js";
import { KnowledgeStore } from "./store.js";

type KnowledgeRow = {
  id: string;
  type: KnowledgeType;
  content: string;
  workspace: string;
  project: string | null;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
};

type EvidenceRow = {
  type: EvidenceType;
  source: string;
  locator: string | null;
  timestamp: string;
};

type SqlParams = Record<string, string | number>;

const KNOWLEDGE_TYPES: KnowledgeType[] = ["fact", "decision", "lesson"];
const KNOWLEDGE_STATUSES: KnowledgeStatus[] = [
  "candidate",
  "verified",
  "superseded",
  "archived",
];
const EVIDENCE_TYPES: EvidenceType[] = ["session", "file", "git"];

/** Persists and queries evidence-backed knowledge items. */
export class KnowledgeRepository {
  private readonly database: KnowledgeStore["database"];

  constructor(store: KnowledgeStore) {
    this.database = store.database;
  }

  create(input: CreateKnowledgeInput): Knowledge {
    validateKnowledgeType(input.type);
    validateContent(input.content);
    const scope = normalizeScope(input.scope);
    const evidence = normalizeEvidence(input.evidence ?? []);
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    return this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO knowledge
            (id, type, content, workspace, project, status, created_at, updated_at)
           VALUES (@id, @type, @content, @workspace, @project, 'candidate', @createdAt, @createdAt)`,
        )
        .run({
          id,
          type: input.type,
          content: input.content,
          workspace: scope.workspace,
          project: scope.project ?? null,
          createdAt,
        });

      this.replaceEvidence(id, evidence);
      const created = this.getById(id);
      if (created === null) {
        throw new Error("Created knowledge item could not be read back.");
      }
      return created;
    })();
  }

  getById(id: string): Knowledge | null {
    const row = this.database
      .prepare("SELECT * FROM knowledge WHERE id = ?")
      .get(id) as KnowledgeRow | undefined;
    if (row === undefined) {
      return null;
    }

    const evidenceRows = this.database
      .prepare(
        `SELECT type, source, locator, timestamp
         FROM knowledge_evidence
         WHERE knowledge_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(id) as EvidenceRow[];

    const scope: KnowledgeScope = { workspace: row.workspace };
    if (row.project !== null) {
      scope.project = row.project;
    }

    return {
      id: row.id,
      type: row.type,
      content: row.content,
      scope,
      status: row.status,
      evidence: evidenceRows.map((item) => {
        const evidence: Evidence = {
          type: item.type,
          source: item.source,
          timestamp: item.timestamp,
        };
        if (item.locator !== null) {
          evidence.locator = item.locator;
        }
        return evidence;
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(options: KnowledgeListOptions = {}): Knowledge[] {
    const { where, params } = buildFilters(options);
    const limitClause = addLimit(options.limit, params);
    const rows = this.database
      .prepare(
        `SELECT id FROM knowledge${where}
         ORDER BY updated_at DESC, created_at DESC, id ASC${limitClause}`,
      )
      .all(params) as Array<{ id: string }>;

    return rows.map((row) => this.requireById(row.id));
  }

  search(query: string, options: KnowledgeListOptions = {}): Knowledge[] {
    if (typeof query !== "string") {
      throw new TypeError("Search query must be a string.");
    }
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const { where, params } = buildFilters(options);
    const searchFilter = "content LIKE @search ESCAPE '\\'";
    const combinedWhere = where.length === 0 ? ` WHERE ${searchFilter}` : `${where} AND ${searchFilter}`;
    params.search = `%${escapeLike(normalizedQuery)}%`;
    const limitClause = addLimit(options.limit, params);
    const rows = this.database
      .prepare(
        `SELECT id FROM knowledge${combinedWhere}
         ORDER BY updated_at DESC, created_at DESC, id ASC${limitClause}`,
      )
      .all(params) as Array<{ id: string }>;

    return rows.map((row) => this.requireById(row.id));
  }

  update(id: string, patch: KnowledgePatch): Knowledge {
    return this.database.transaction(() => {
      const current = this.requireById(id);
      const type = patch.type === undefined ? current.type : validateKnowledgeType(patch.type);
      const content = patch.content === undefined ? current.content : validateContent(patch.content);
      const scope = patch.scope === undefined ? current.scope : normalizeScope(patch.scope);
      const status = patch.status === undefined ? current.status : validateKnowledgeStatus(patch.status);
      if (!isValidTransition(current.status, status)) {
        throw invalidTransition(current.status, status);
      }
      const evidence = patch.evidence === undefined ? undefined : normalizeEvidence(patch.evidence);
      const updatedAt = nextTimestamp(current.updatedAt);

      this.database
        .prepare(
          `UPDATE knowledge
           SET type = @type, content = @content, workspace = @workspace,
               project = @project, status = @status, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          type,
          content,
          workspace: scope.workspace,
          project: scope.project ?? null,
          status,
          updatedAt,
        });

      if (evidence !== undefined) {
        this.replaceEvidence(id, evidence);
      }
      return this.requireById(id);
    })();
  }

  archive(id: string): Knowledge {
    return this.update(id, { status: "archived" });
  }

  supersede(id: string, replacementId: string): Knowledge {
    return this.database.transaction(() => {
      const current = this.requireById(id);
      const replacement = this.requireById(replacementId);
      if (id === replacementId) {
        throw new Error("A knowledge item cannot supersede itself.");
      }
      if (current.status !== "verified") {
        throw invalidTransition(current.status, "superseded");
      }
      if (replacement.status !== "verified") {
        throw new Error("Replacement knowledge must be verified before superseding another item.");
      }
      if (
        current.scope.workspace !== replacement.scope.workspace ||
        (current.scope.project ?? null) !== (replacement.scope.project ?? null)
      ) {
        throw new Error("Replacement knowledge must have the same workspace and project scope.");
      }

      this.database
        .prepare(
          `UPDATE knowledge
           SET status = 'superseded', replacement_id = @replacementId, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({ id, replacementId, updatedAt: nextTimestamp(current.updatedAt) });
      return this.requireById(id);
    })();
  }

  private replaceEvidence(id: string, evidence: Evidence[]): void {
    this.database
      .prepare("DELETE FROM knowledge_evidence WHERE knowledge_id = ?")
      .run(id);
    const insert = this.database.prepare(
      `INSERT INTO knowledge_evidence
        (knowledge_id, ordinal, type, source, locator, timestamp)
       VALUES (@knowledgeId, @ordinal, @type, @source, @locator, @timestamp)`,
    );
    evidence.forEach((item, ordinal) => {
      insert.run({
        knowledgeId: id,
        ordinal,
        type: item.type,
        source: item.source,
        locator: item.locator ?? null,
        timestamp: item.timestamp,
      });
    });
  }

  private requireById(id: string): Knowledge {
    const item = this.getById(id);
    if (item === null) {
      throw new Error(`Knowledge item not found: ${id}`);
    }
    return item;
  }
}

function buildFilters(options: KnowledgeListOptions): {
  where: string;
  params: SqlParams;
} {
  const clauses: string[] = [];
  const params: SqlParams = {};

  if (options.workspace !== undefined) {
    clauses.push("workspace = @workspace");
    params.workspace = options.workspace;
  }
  if (options.project === null) {
    clauses.push("project IS NULL");
  } else if (options.project !== undefined) {
    clauses.push("project = @project");
    params.project = options.project;
  }
  if (options.type !== undefined) {
    validateKnowledgeType(options.type);
    clauses.push("type = @type");
    params.type = options.type;
  }
  if (options.status !== undefined) {
    validateKnowledgeStatus(options.status);
    clauses.push("status = @status");
    params.status = options.status;
  }

  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function addLimit(limit: number | undefined, params: SqlParams): string {
  if (limit === undefined) {
    return "";
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Limit must be a positive integer.");
  }
  params.limit = limit;
  return " LIMIT @limit";
}

function validateKnowledgeType(value: KnowledgeType): KnowledgeType {
  if (!KNOWLEDGE_TYPES.includes(value)) {
    throw new TypeError(`Invalid knowledge type: ${String(value)}`);
  }
  return value;
}

function validateKnowledgeStatus(value: KnowledgeStatus): KnowledgeStatus {
  if (!KNOWLEDGE_STATUSES.includes(value)) {
    throw new TypeError(`Invalid knowledge status: ${String(value)}`);
  }
  return value;
}

function validateContent(content: string): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new TypeError("Knowledge content must not be empty.");
  }
  return content;
}

function normalizeScope(scope: KnowledgeScope): KnowledgeScope {
  if (typeof scope?.workspace !== "string" || scope.workspace.trim().length === 0) {
    throw new TypeError("Knowledge scope must include a non-empty workspace.");
  }
  if (scope.project !== undefined && (typeof scope.project !== "string" || scope.project.trim().length === 0)) {
    throw new TypeError("Project scope must be a non-empty string when provided.");
  }

  const normalized: KnowledgeScope = { workspace: scope.workspace };
  if (scope.project !== undefined) {
    normalized.project = scope.project;
  }
  return normalized;
}

function normalizeEvidence(evidence: Evidence[]): Evidence[] {
  if (!Array.isArray(evidence)) {
    throw new TypeError("Evidence must be an array.");
  }

  return evidence.map((item) => {
    if (!EVIDENCE_TYPES.includes(item.type)) {
      throw new TypeError(`Invalid evidence type: ${String(item.type)}`);
    }
    if (typeof item.source !== "string" || item.source.trim().length === 0) {
      throw new TypeError("Evidence source must not be empty.");
    }
    if (item.locator !== undefined && typeof item.locator !== "string") {
      throw new TypeError("Evidence locator must be a string when provided.");
    }
    if (item.locator !== undefined && item.locator.length === 0) {
      throw new TypeError("Evidence locator must not be empty when provided.");
    }
    if (!isIsoTimestamp(item.timestamp)) {
      throw new TypeError(`Evidence timestamp must be an ISO timestamp: ${String(item.timestamp)}`);
    }

    const normalized: Evidence = {
      type: item.type,
      source: item.source,
      timestamp: item.timestamp,
    };
    if (item.locator !== undefined) {
      normalized.locator = item.locator;
    }
    return normalized;
  });
}

function isIsoTimestamp(value: string): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isValidTransition(
  current: KnowledgeStatus,
  next: KnowledgeStatus,
): boolean {
  if (current === next) {
    return true;
  }
  if (current === "candidate") {
    return next === "verified" || next === "archived";
  }
  if (current === "verified") {
    return next === "archived";
  }
  return current === "superseded" && next === "archived";
}

function invalidTransition(current: KnowledgeStatus, next: KnowledgeStatus): Error {
  const hint = next === "superseded" ? " Use supersede(id, replacementId) instead." : "";
  return new Error(`Invalid knowledge status transition: ${current} -> ${next}.${hint}`);
}

function nextTimestamp(previous: string): string {
  const now = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Math.max(now, previousTime + 1)).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
