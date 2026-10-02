import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KnowledgeRepository,
  KnowledgeStore,
  checkKnowledgeHealth,
  MAX_RETRIEVAL_RESULTS,
  RETRIEVAL_SCORING,
  retrieveRelevantKnowledge,
  type CreateKnowledgeInput,
  type Knowledge,
} from "../src/index.js";
import { createTemporaryGitRepository, initializeGitRepository } from "./git-fixtures.js";

const timestamp = "2026-10-01T10:00:00.000Z";

describe("deterministic knowledge retrieval", () => {
  let store: KnowledgeStore;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    store = new KnowledgeStore(":memory:");
    repository = new KnowledgeRepository(store);
  });

  afterEach(() => {
    store.close();
  });

  it("ranks an exact normalized phrase above a loose token match", () => {
    const phrase = create("Routing layer handles retries before returning to callers.");
    const loose = create("Retries are handled by the routing layer after other checks.");

    const results = retrieve("routing layer handles retries");

    expect(results.map(({ knowledge }) => knowledge.id)[0]).toBe(phrase.id);
    expect(results[0]?.explanation.matchType).toBe("exact_phrase");
    expect(results[0]?.explanation.contributions.exactPhrase).toBe(
      RETRIEVAL_SCORING.exactPhrase,
    );
    expect(results.map(({ knowledge }) => knowledge.id)).toContain(loose.id);
  });

  it("normalizes case and punctuation and reports partial token matches", () => {
    const punctuation = create("PAYMENT router—fallback uses the shared policy.");
    const partial = create("Response routing conventions are documented here.");

    const normalizedResults = retrieve("payment-router: FALLBACK!");
    const partialResults = retrieve("ResponseRouter");

    expect(normalizedResults[0]?.knowledge.id).toBe(punctuation.id);
    expect(partialResults.map(({ knowledge }) => knowledge.id)).toContain(partial.id);
    expect(partialResults.find(({ knowledge }) => knowledge.id === partial.id)?.explanation.matchType)
      .toBe("partial_tokens");
  });

  it("scores token coverage so results matching more query terms rank higher", () => {
    const twoTokens = create("Alpha has a gamma component.");
    const oneToken = create("Alpha is configured independently.");

    const results = retrieve("alpha beta gamma");

    expect(results.map(({ knowledge }) => knowledge.id)).toEqual([twoTokens.id, oneToken.id]);
    expect(results[0]?.explanation.tokenCoverage).toBe(0.667);
    expect(results[1]?.explanation.tokenCoverage).toBe(0.333);
  });

  it("omits unrelated content", () => {
    create("SQLite uses a local database.");

    expect(retrieve("provider fallback routing")).toEqual([]);
  });

  it("ranks project-scoped records above workspace-wide records after textual relevance", () => {
    const project = create("ResponseRouter provider selection uses the fallback boundary.", {
      scope: { workspace: "workspace-a", project: "payments" },
    });
    const workspace = create("ResponseRouter provider selection uses the shared boundary.", {
      scope: { workspace: "workspace-a" },
      status: "verified",
    });

    const results = retrieve("ResponseRouter provider selection", {
      workspace: "workspace-a",
      project: "payments",
    });

    expect(results.map(({ knowledge }) => knowledge.id)).toEqual([project.id, workspace.id]);
    expect(results[0]?.explanation.contributions.scope).toBe(
      RETRIEVAL_SCORING.projectScopeMultiplier,
    );
  });

  it("does not retrieve another workspace or another project", () => {
    const sameProject = create("ResponseRouter handles provider fallback.", {
      scope: { workspace: "workspace-a", project: "payments" },
    });
    create("ResponseRouter handles provider fallback.", {
      scope: { workspace: "workspace-b", project: "payments" },
    });
    create("ResponseRouter handles provider fallback.", {
      scope: { workspace: "workspace-a", project: "identity" },
    });

    expect(retrieve("ResponseRouter provider fallback", {
      workspace: "workspace-a",
      project: "payments",
    }).map(({ knowledge }) => knowledge.id)).toEqual([sameProject.id]);
    expect(retrieve("ResponseRouter provider fallback", {
      workspace: "workspace-a",
      project: null,
    })).toEqual([]);
  });

  it("ranks verified knowledge above candidate knowledge when relevance and scope match", () => {
    const candidate = create("ResponseRouter fallback policy is stable.");
    const verified = create("ResponseRouter fallback policy is stable.", { status: "verified" });
    setTimes(candidate, timestamp, timestamp);
    setTimes(verified, timestamp, timestamp);

    const results = retrieve("ResponseRouter fallback policy");

    expect(results.map(({ knowledge }) => knowledge.id)).toEqual([verified.id]);
    expect(results[0]?.explanation.contributions.status).toBe(
      RETRIEVAL_SCORING.verifiedStatusMultiplier,
    );
  });

  it("excludes automatic candidates before scoring while keeping explicit candidates eligible", () => {
    const explicit = create("ResponseRouter fallback policy is stable.");
    const automatic = create("ResponseRouter fallback policy is stable.", {
      creationOrigin: "automatic",
    });

    expect(retrieve("ResponseRouter fallback policy").map(({ knowledge }) => knowledge.id))
      .toEqual([explicit.id]);
    expect(repository.getById(automatic.id)?.creationOrigin).toBe("automatic");
  });

  it("retrieves automatic-origin knowledge after explicit verification", () => {
    const automatic = create("ResponseRouter fallback policy is stable.", {
      creationOrigin: "automatic",
    });
    repository.update(automatic.id, { status: "verified" });

    expect(retrieve("ResponseRouter fallback policy").map(({ knowledge }) => knowledge.id))
      .toContain(automatic.id);
  });

  it("leaves M2 scores and ordering for eligible records unchanged when automatic candidates exist", () => {
    const explicit = create("ResponseRouter fallback policy is stable.");
    const verified = create("ResponseRouter fallback behavior stays stable across projects.", {
      status: "verified",
    });
    setTimes(explicit, timestamp, timestamp);
    setTimes(verified, timestamp, timestamp);
    const before = retrieve("ResponseRouter fallback policy").map(({ knowledge, score }) => ({
      id: knowledge.id,
      score,
    }));

    create("ResponseRouter fallback policy is stable.", { creationOrigin: "automatic" });
    const after = retrieve("ResponseRouter fallback policy").map(({ knowledge, score }) => ({
      id: knowledge.id,
      score,
    }));

    expect(after).toEqual(before);
    expect(before.some(({ id }) => id === verified.id)).toBe(true);
    expect(before.map(({ id }) => id)).toContain(explicit.id);
  });

  it("never returns archived or superseded knowledge", () => {
    const archived = create("Archived ResponseRouter fallback guidance.");
    repository.archive(archived.id);

    const superseded = create("Superseded ResponseRouter fallback guidance.");
    const replacement = create("A new principle about retry behavior.");
    repository.update(superseded.id, { status: "verified" });
    repository.update(replacement.id, { status: "verified" });
    repository.supersede(superseded.id, replacement.id);

    expect(retrieve("ResponseRouter fallback guidance")).toEqual([]);
  });

  it("does not change M2 eligibility when Git-backed knowledge may be stale", async () => {
    const gitRepository = createTemporaryGitRepository("dsh-knowledge-retrieval-health-");
    try {
      await initializeGitRepository(gitRepository.directory);
      gitRepository.write("src/policy.ts", "original policy\n");
      const commit = await gitRepository.commit("initial policy");
      gitRepository.write("src/policy.ts", "changed policy\n");
      const item = create("ResponseRouter policy keeps authorization scoped.", {
        evidence: [{
          type: "file",
          source: "src/policy.ts",
          timestamp,
          gitProvenance: { commit, path: "src/policy.ts" },
        }],
      });

      const health = await checkKnowledgeHealth(item, {
        workspaceDirectory: gitRepository.directory,
      });
      const ranked = retrieve("ResponseRouter policy authorization");

      expect(health.status).toBe("potentially_stale");
      expect(ranked.map(({ knowledge }) => knowledge.id)).toContain(item.id);
    } finally {
      gitRepository.cleanup();
    }
  }, 20_000);

  it("uses recency only after textual relevance and other ranking dimensions", () => {
    const olderStrongMatch = create("Router fallback handles provider retries safely.");
    const recentPartialMatch = create("Provider retries use the routing layer and fallback.");
    setTimes(olderStrongMatch, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    setTimes(recentPartialMatch, "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");

    const relevanceResults = retrieve("router fallback handles provider retries");
    expect(relevanceResults[0]?.knowledge.id).toBe(olderStrongMatch.id);

    const oldPhrase = create(
      "ResponseRouter provider selection is the agreed payment routing boundary for this project.",
    );
    const newPhrase = create(
      "ResponseRouter provider selection forms the primary payment handler boundary for every service.",
    );
    setTimes(oldPhrase, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    setTimes(newPhrase, "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const freshnessResults = retrieve("ResponseRouter provider selection");

    expect(freshnessResults.slice(0, 2).map(({ knowledge }) => knowledge.id)).toEqual([
      newPhrase.id,
      oldPhrase.id,
    ]);
    expect(freshnessResults[0]?.explanation.contributions.freshness).toBeGreaterThan(
      freshnessResults[1]?.explanation.contributions.freshness ?? 0,
    );
  });

  it("uses evidence availability as a small tie-break when text and scope match", () => {
    const noEvidence = create(
      "ResponseRouter fallback policy is stable across the current payments workspace.",
    );
    const evidence = create(
      "ResponseRouter fallback policy remains stable through changes in the provider layer.", {
      evidence: [
        { type: "file", source: "src/router.ts", timestamp },
        { type: "git", source: "commit:abc123", timestamp },
      ],
      },
    );
    setTimes(noEvidence, timestamp, timestamp);
    setTimes(evidence, timestamp, timestamp);

    const results = retrieve("ResponseRouter fallback policy");

    expect(results.map(({ knowledge }) => knowledge.id)).toEqual([evidence.id, noEvidence.id]);
    expect(results[0]?.explanation.contributions.evidence).toBe(2);
  });

  it("supports explicit type preferences without making type an implicit relevance signal", () => {
    const fact = create("ResponseRouter fallback policy is stable.", { type: "fact" });
    const lesson = create("ResponseRouter fallback policy is stable.", { type: "lesson" });
    setTimes(fact, timestamp, timestamp);
    setTimes(lesson, timestamp, timestamp);

    const unweighted = retrieve("ResponseRouter fallback policy");
    expect(unweighted.map(({ knowledge }) => knowledge.id)).toEqual(
      [fact.id, lesson.id].sort(),
    );

    const preferred = retrieve("ResponseRouter fallback policy", {
      preferredTypes: ["lesson", "decision", "fact"],
    });
    expect(preferred.map(({ knowledge }) => knowledge.id)).toEqual([lesson.id, fact.id]);
    expect(preferred[0]?.explanation.contributions.type).toBe(30);
  });

  it("suppresses conservative near-duplicates but keeps distinct decisions and lessons", () => {
    const first = create(
      "ResponseRouter routes payment provider requests through the shared fallback adapter during transient failures.",
      { type: "lesson" },
    );
    const duplicate = create(
      "ResponseRouter routes payment provider requests consistently through the shared fallback adapter during transient failures.",
      { type: "lesson" },
    );
    const affirmative = create(
      "ResponseRouter must use the payment provider fallback adapter during transient failures for predictable routing outcomes.",
      { type: "decision" },
    );
    const negative = create(
      "ResponseRouter must not use the payment provider fallback adapter during transient failures for predictable routing outcomes.",
      { type: "decision" },
    );
    const validateFirst = create(
      "ResponseRouter must validate payment provider fallback inputs before writing the final persistent knowledge record.",
      { type: "decision" },
    );
    const writeFirst = create(
      "ResponseRouter must write the final persistent knowledge record before validating payment provider fallback inputs.",
      { type: "decision" },
    );

    const results = retrieve("ResponseRouter payment provider fallback");
    const ids = results.map(({ knowledge }) => knowledge.id);

    const representative = results.find(({ knowledge }) =>
      knowledge.id === first.id || knowledge.id === duplicate.id,
    );
    expect(representative).toBeDefined();
    expect(ids).not.toContain(representative?.knowledge.id === first.id ? duplicate.id : first.id);
    expect(representative?.explanation.suppressedSimilarIds).toContain(
      representative?.knowledge.id === first.id ? duplicate.id : first.id,
    );
    expect(ids).toContain(affirmative.id);
    expect(ids).toContain(negative.id);
    expect(ids).toContain(validateFirst.id);
    expect(ids).toContain(writeFirst.id);
  });

  it("uses stable ID ordering to break otherwise equal ties", () => {
    const first = create("Router fallback uses an adapter.");
    const second = create("Router fallback forwards to a gateway.");
    setTimes(first, timestamp, timestamp);
    setTimes(second, timestamp, timestamp);

    const results = retrieve("router fallback");
    const expected = [first.id, second.id].sort();

    expect(results.map(({ knowledge }) => knowledge.id)).toEqual(expected);
    expect(retrieve("router fallback").map(({ knowledge }) => knowledge.id)).toEqual(expected);
  });

  it.each([
    ["", "empty"],
    ["the and or", "stop words"],
    ["x", "short noise"],
    ["!!!", "punctuation"],
  ])("returns no results for %s (%s)", (query) => {
    create("The router handles fallback behavior.");
    expect(retrieve(query)).toEqual([]);
  });

  it("enforces the requested and absolute result bounds", () => {
    for (let index = 0; index < MAX_RETRIEVAL_RESULTS + 5; index += 1) {
      create(`router handles fallback case number ${index} independently`);
    }

    expect(retrieve("router fallback", { limit: 2 })).toHaveLength(2);
    expect(retrieve("router fallback", { limit: MAX_RETRIEVAL_RESULTS + 5 })).toHaveLength(
      MAX_RETRIEVAL_RESULTS,
    );
  });

  it("rejects invalid bounds and never accepts terminal statuses as filters", () => {
    expect(() => retrieve("router", { limit: 0 })).toThrow(/positive integer/);
    expect(() => retrieve("router", { status: "archived" as "candidate" })).toThrow(
      /Invalid retrieval status/,
    );
  });

  function create(
    content: string,
    overrides: Partial<Omit<CreateKnowledgeInput, "content">> & {
      status?: "candidate" | "verified";
    } = {},
  ): Knowledge {
    const { status, ...inputOverrides } = overrides;
    const item = repository.create({
      type: "fact",
      content,
      scope: { workspace: "workspace-a", project: "payments" },
      ...inputOverrides,
    });
    return status === undefined ? item : repository.update(item.id, { status });
  }

  function retrieve(
    query: string,
    options: Partial<Parameters<typeof retrieveRelevantKnowledge>[2]> = {},
  ) {
    return retrieveRelevantKnowledge(repository, query, {
      workspace: "workspace-a",
      project: "payments",
      ...options,
    });
  }

  function setTimes(item: Knowledge, updatedAt: string, createdAt: string): void {
    store.database
      .prepare("UPDATE knowledge SET updated_at = ?, created_at = ? WHERE id = ?")
      .run(updatedAt, createdAt, item.id);
  }
});
