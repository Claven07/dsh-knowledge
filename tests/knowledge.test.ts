import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KnowledgeRepository,
  KnowledgeStore,
  type CreateKnowledgeInput,
  type Evidence,
} from "../src/index.js";

const timestamp = "2026-10-01T10:00:00.000Z";

function input(overrides: Partial<CreateKnowledgeInput> = {}): CreateKnowledgeInput {
  return {
    type: "fact",
    content: "SQLite writes are transactional.",
    scope: { workspace: "workspace-a", project: "project-a" },
    evidence: [
      {
        type: "file",
        source: "README.md",
        locator: "Storage section",
        timestamp,
      },
    ],
    ...overrides,
  };
}

describe("KnowledgeRepository", () => {
  let directory: string;
  let databasePath: string;
  let store: KnowledgeStore;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dsh-knowledge-"));
    databasePath = join(directory, "knowledge.sqlite");
    store = new KnowledgeStore(databasePath);
    repository = new KnowledgeRepository(store);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe("creation and retrieval", () => {
    it("creates a candidate with a generated ID, timestamps, and evidence", () => {
      const item = repository.create(input());

      expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(item.status).toBe("candidate");
      expect(item.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(item.updatedAt).toBe(item.createdAt);
      expect(item.evidence).toEqual(input().evidence);
      expect(item.scope).toEqual({ workspace: "workspace-a", project: "project-a" });
    });

    it("returns the complete reconstructed item and null for an unknown ID", () => {
      const created = repository.create(input({
        evidence: [
          { type: "session", source: "session-12", timestamp },
          { type: "git", source: "commit:abc123", locator: "src/store.ts", timestamp },
        ],
      }));

      expect(repository.getById(created.id)).toEqual(created);
      expect(repository.getById("missing-id")).toBeNull();
    });

    it("round-trips normalized SHA-1 and SHA-256 file provenance", () => {
      const item = repository.create(input({
        evidence: [
          {
            type: "file",
            source: "src/router.ts",
            timestamp,
            gitProvenance: { commit: "A".repeat(40), path: "./src\\router.ts" },
          },
          {
            type: "file",
            source: "src/store.ts",
            timestamp,
            gitProvenance: { commit: "b".repeat(64), path: "src/store.ts" },
          },
        ],
      }));

      expect(item.evidence[0]?.gitProvenance).toEqual({
        commit: "a".repeat(40),
        path: "src/router.ts",
      });
      expect(repository.getById(item.id)).toEqual(item);
    });

    it("stores workspace-wide knowledge without adding a project field", () => {
      const created = repository.create(input({ scope: { workspace: "workspace-a" } }));

      expect(created.scope).toEqual({ workspace: "workspace-a" });
    });

    it("rejects empty content and invalid evidence timestamps", () => {
      expect(() => repository.create(input({ content: "  " }))).toThrow(/content/);
      const invalidEvidence: Evidence[] = [
        { type: "file", source: "README.md", timestamp: "yesterday" },
      ];
      expect(() => repository.create(input({ evidence: invalidEvidence }))).toThrow(/ISO timestamp/);
    });

    it.each([
      { commit: "not-a-commit", path: "README.md" },
      { commit: "a".repeat(40), path: "../outside.ts" },
      { commit: "a".repeat(40), path: "C:\\outside.ts" },
      { commit: "a".repeat(40), path: "" },
    ])("rejects invalid Git provenance $commit $path", (gitProvenance) => {
      expect(() => repository.create(input({
        evidence: [{
          type: "file",
          source: "README.md",
          timestamp,
          gitProvenance,
        }],
      }))).toThrow();
    });

    it("only permits Git provenance on file evidence", () => {
      expect(() => repository.create(input({
        evidence: [{
          type: "session",
          source: "session-1",
          timestamp,
          gitProvenance: { commit: "a".repeat(40), path: "README.md" },
        }],
      }))).toThrow(/file evidence/);
    });
  });

  describe("listing", () => {
    it("filters by workspace, project, type, and status", () => {
      const apiFact = repository.create(input());
      const webDecision = repository.create(input({
        type: "decision",
        content: "Use a single local database.",
        scope: { workspace: "workspace-a", project: "project-b" },
      }));
      const otherWorkspaceLesson = repository.create(input({
        type: "lesson",
        content: "Keep evidence alongside each item.",
        scope: { workspace: "workspace-b", project: "project-a" },
      }));
      repository.update(webDecision.id, { status: "verified" });

      expect(repository.list({ workspace: "workspace-a" }).map(({ id }) => id)).toEqual(
        expect.arrayContaining([apiFact.id, webDecision.id]),
      );
      expect(repository.list({ project: "project-a" }).map(({ id }) => id)).toEqual(
        expect.arrayContaining([apiFact.id, otherWorkspaceLesson.id]),
      );
      expect(repository.list({ type: "decision" }).map(({ id }) => id)).toEqual([webDecision.id]);
      expect(repository.list({ status: "verified" }).map(({ id }) => id)).toEqual([webDecision.id]);
      expect(repository.list({ workspace: "workspace-a", project: null })).toEqual([]);
      expect(repository.list({ limit: 1 })).toHaveLength(1);
    });

    it("keeps similarly named projects isolated by workspace and exact project scope", () => {
      const alpha = repository.create(input({
        scope: { workspace: "alpha", project: "service" },
        content: "Alpha service configuration.",
      }));
      const beta = repository.create(input({
        scope: { workspace: "beta", project: "service" },
        content: "Beta service configuration.",
      }));
      const workspaceNote = repository.create(input({
        scope: { workspace: "alpha" },
        content: "Alpha workspace configuration.",
      }));

      expect(repository.list({ workspace: "alpha", project: "service" }).map(({ id }) => id)).toEqual([
        alpha.id,
      ]);
      expect(repository.list({ workspace: "alpha", project: null }).map(({ id }) => id)).toEqual([
        workspaceNote.id,
      ]);
      expect(repository.search("configuration", { workspace: "beta" }).map(({ id }) => id)).toEqual([
        beta.id,
      ]);
    });
  });

  describe("search", () => {
    it("finds matching content without returning unrelated entries", () => {
      const match = repository.create(input({ content: "Use WAL mode for local writes." }));
      repository.create(input({ content: "The project uses TypeScript." }));

      expect(repository.search("WAL").map(({ id }) => id)).toEqual([match.id]);
      expect(repository.search("   ")).toEqual([]);
    });

    it("treats LIKE wildcard characters in the query as literal text", () => {
      const match = repository.create(input({ content: "The identifier is item_100%." }));
      repository.create(input({ content: "The identifier is itemX1000." }));

      expect(repository.search("item_100%").map(({ id }) => id)).toEqual([match.id]);
    });
  });

  describe("updates", () => {
    it("updates mutable fields while preserving ID and creation time", () => {
      const created = repository.create(input());
      const updated = repository.update(created.id, {
        content: "SQLite commits each item atomically.",
        status: "verified",
      });

      expect(updated.content).toBe("SQLite commits each item atomically.");
      expect(updated.status).toBe("verified");
      expect(updated.id).toBe(created.id);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect(updated.evidence).toEqual(created.evidence);
    });

    it("replaces or clears evidence only when the patch includes evidence", () => {
      const created = repository.create(input());
      const changedEvidence: Evidence[] = [
        { type: "git", source: "commit:deadbeef", timestamp },
      ];

      expect(repository.update(created.id, { evidence: changedEvidence }).evidence).toEqual(changedEvidence);
      expect(repository.update(created.id, { evidence: [] }).evidence).toEqual([]);
    });

    it("throws when updating a missing item", () => {
      expect(() => repository.update("missing-id", { content: "new" })).toThrow(/not found/);
    });
  });

  describe("lifecycle", () => {
    it("supports candidate to verified to superseded to archived", () => {
      const oldItem = repository.create(input({ content: "Use database schema version one." }));
      const replacement = repository.create(input({ content: "Use database schema version two." }));
      repository.update(replacement.id, { status: "verified" });

      const verified = repository.update(oldItem.id, { status: "verified" });
      expect(verified.status).toBe("verified");

      const superseded = repository.supersede(oldItem.id, replacement.id);
      expect(superseded.status).toBe("superseded");
      expect(() => repository.update(oldItem.id, { status: "candidate" })).toThrow(
        /superseded -> candidate/,
      );
      expect(() => repository.supersede(oldItem.id, replacement.id)).toThrow(
        /superseded -> superseded/,
      );

      expect(repository.archive(oldItem.id).status).toBe("archived");
    });

    it("allows a candidate to be archived", () => {
      const candidate = repository.create(input());
      expect(repository.archive(candidate.id).status).toBe("archived");
    });

    it("rejects invalid status transitions", () => {
      const archived = repository.archive(repository.create(input()).id);
      expect(() => repository.update(archived.id, { status: "verified" })).toThrow(/archived -> verified/);

      const candidate = repository.create(input({ content: "Candidate that cannot be superseded." }));
      expect(() => repository.update(candidate.id, { status: "superseded" })).toThrow(/supersede\(id, replacementId\)/);

      const verified = repository.update(candidate.id, { status: "verified" });
      expect(() => repository.update(verified.id, { status: "candidate" })).toThrow(/verified -> candidate/);
    });

    it("requires a verified replacement with the same scope", () => {
      const original = repository.create(input());
      const candidateReplacement = repository.create(input({ content: "Not verified yet." }));
      repository.update(original.id, { status: "verified" });

      expect(() => repository.supersede(original.id, candidateReplacement.id)).toThrow(/must be verified/);
      repository.update(candidateReplacement.id, { status: "verified" });
      const otherScope = repository.create(input({
        content: "Different scope replacement.",
        scope: { workspace: "workspace-b", project: "project-a" },
      }));
      repository.update(otherScope.id, { status: "verified" });
      expect(() => repository.supersede(original.id, otherScope.id)).toThrow(/same workspace and project/);
      expect(() => repository.supersede(original.id, original.id)).toThrow(/cannot supersede itself/);
    });
  });

  it("persists knowledge and evidence after closing and reopening the database", () => {
    const created = repository.create(input());
    store.close();
    store = new KnowledgeStore(databasePath);
    repository = new KnowledgeRepository(store);

    expect(repository.getById(created.id)).toEqual(created);
  });
});
