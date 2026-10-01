# dsh-knowledge

`dsh-knowledge` is a local, evidence-backed project knowledge layer for coding agents. It stores durable project facts, engineering decisions, and lessons in SQLite, with explicit workspace/project scope and lifecycle status.

Ordinary chat memory often retains conversational details without showing what a statement describes or where it came from. `dsh-knowledge` keeps evidence as first-class records so future integrations can connect knowledge to sessions, files, and Git history. Evidence is caller-supplied in M0/M1; automatic discovery is not implemented.

## Status

M0 core storage, M1 native DeepSeek Harness tools, and M2 deterministic ranked retrieval are implemented. **DeepSeek Harness integration was not part of M0; it is implemented as the separate `dsh-knowledge/plugin` entry point.** The storage/domain and retrieval APIs remain usable without DeepSeek Harness.

## Capabilities

- Local SQLite storage through `better-sqlite3`; no ORM or remote service.
- Create, get, list, deterministic `LIKE` search, update, archive, and supersede knowledge through the core repository.
- Normalized evidence records and workspace/project scope.
- Five DSH tools: `knowledge_add`, `knowledge_search`, `knowledge_list`, `knowledge_get`, and `knowledge_archive`.
- Session evidence on explicit tool-created items when DSH provides a calling agent/session.
- Bounded model inputs and results; the add tool advises against persisting credentials or secrets (there is no secret scanner).
- Bounded `agent/pre-step` retrieval from the current workspace and optional configured project. It ranks relevant project entries before workspace-wide entries, prefers verified entries at equal scope, excludes archived/superseded entries, suppresses conservative near-duplicates, and injects compact context only.
- Retrieval/storage failures are logged and do not stop agent execution.

There is no automatic LLM extraction, embeddings, vector search, external API, HTTP server, or UI.

## Installation

### Core library

After the package is published, install the core library with:

```sh
npm install dsh-knowledge
```

Importing `dsh-knowledge` does not load DeepSeek Harness packages. The DSH adapter is an optional package subpath.

### DeepSeek Harness plugin from a local checkout

With the DSH CLI and a configured profile available, build and install the checkout as a bundle:

```sh
npm install
npm run build
dsh plugin --profile <profile> add .
```

The repository declares a `dsh.bundle` patch that registers `dsh-knowledge/plugin`. For a GitHub installation, the current Harness packaging flow is:

```sh
dsh plugin --profile <profile> add github:Claven07/dsh-knowledge
```

Git installs build from source through the package `prepare` script. pnpm 10 may require allowing the package build in that profile's `pnpm-workspace.yaml` before the install can complete. Review the package source before allowing install-time builds.

The SQLite file defaults to `$DSH_HOME/knowledge/knowledge.sqlite`, using the Harness home resolver (`$DSH_HOME`, then `~/.dsh`). Optional plugin settings are `databasePath`, `dshHome`, and `project`. `databasePath` can be absolute or relative to the process working directory. To select a project for retrieval, add an id-targeted config override to the profile's `cordis.patch.yml`:

```yaml
- id: dsh-knowledge
  name: dsh-knowledge/plugin
  config:
    project: payments
```

The override replaces the row's full config, so include every setting you need to retain. When no project label is configured, automatic retrieval considers workspace-wide items only; the current Session API supplies `cwd` but no project identity. Tool calls default to the configured project and can pass `project: null` to select or create workspace-wide knowledge.

## Core usage

```ts
import {
  KnowledgeRepository,
  KnowledgeStore,
  retrieveRelevantKnowledge,
} from "dsh-knowledge";

const store = new KnowledgeStore(".dsh-knowledge/knowledge.sqlite");
const knowledge = new KnowledgeRepository(store);

const item = knowledge.create({
  type: "decision",
  content: "Provider selection must use ResponseRouter.",
  scope: { workspace: "/work/payments", project: "payments" },
  evidence: [
    {
      type: "file",
      source: "src/router.ts",
      locator: "ResponseRouter",
      timestamp: new Date().toISOString(),
    },
  ],
});

const matches = knowledge.search("ResponseRouter", {
  workspace: "/work/payments",
  project: "payments",
});

const ranked = retrieveRelevantKnowledge(knowledge, "provider fallback routing", {
  workspace: "/work/payments",
  project: "payments",
  limit: 8,
});

store.close();
```

`repository.search()` remains a deterministic literal `LIKE` search. The separate `retrieveRelevantKnowledge()` API performs explainable relevance ranking and returns each `Knowledge` with a score breakdown.

`create()` assigns a UUID and timestamps and starts an item as `candidate`. Candidates can be verified or archived. Verified items can be archived or superseded by another verified item in the same scope; superseded items can be archived.

## DSH architecture

```text
DeepSeek Harness hooks and tools
            │
            ├── session/event ── injection-ID deduplication
            ├── agent/pre-step ─ retrieval and compact context
            └── ctx.tools.register() ─ model-facing knowledge tools
                                  │
                       DSH adapter package
                                  │
                       KnowledgeRepository
                                  │
                          KnowledgeStore
                                  │
                              SQLite
```

`src/knowledge` has no Harness imports. `src/harness` is the adapter layer and is exposed through `dsh-knowledge/plugin`. DSH tools use the current `defineTool`/`ctx.tools.register()` API. Their structured JSON results are concise; content is truncated in result summaries, and `knowledge_get` returns a bounded evidence list.

The adapter gets a workspace from the active session's `header.cwd`. The project name is configured explicitly because the current Session header does not provide one. Tool calls can pass workspace/project filters. A configured project is the default exact scope; without a configured project, tools default to workspace-wide knowledge only. `knowledge_add`, `knowledge_search`, `knowledge_list`, `knowledge_get`, and `knowledge_archive` accept `project: null` to select workspace-wide scope explicitly. Tool-created knowledge uses `exec.agent.session.id` for session evidence and timestamps evidence at creation time.

Before an agent request, `agent/pre-step` passes the latest user-authored text in the proposed step to the core retrieval engine. It retrieves at most four items and injects no more than 1,800 characters in a `<dsh-knowledge>` block. Stored text is quoted and labeled untrusted; directives in it should not be followed. Retrieval considers candidate and verified knowledge only. If a project is configured, exact-project entries rank above workspace-wide entries when textual relevance is equal; verified entries rank above candidates at equal scope. If no project is configured, retrieval is workspace-wide only. A session event observer remembers committed injected IDs in memory, scans a session transcript once to cover sessions present at plugin load, and releases state on session disposal; events are not stored in SQLite.

## Deterministic retrieval (M2)

M2 uses local text and existing metadata; it does not use embeddings, an LLM, or external services. Query and content text are Unicode-normalized, lowercased, and split on punctuation. Common stopwords are ignored, and only the first 16 meaningful query tokens are scored. A normalized exact phrase match is detected in addition to exact token and conservative partial-token matches. Text with no meaningful token match is not returned.

The ranking score is an integer built from fixed, centralized weights:

| Dimension | Contribution |
| --- | ---: |
| Exact normalized phrase | 1,000 text points |
| Exact token match | 100 text points per token |
| Partial token match | 40 text points per token |
| Token coverage | Up to 400 text points |
| Exact configured project scope | 1,000 ranking points |
| Verified status | 100 ranking points |
| Explicit preferred type | 10 points per preference rank |
| Evidence availability | 0–3 points |
| Relative freshness | 1–4 points |

Text points are multiplied by 10,000, so scope, verification, and metadata cannot outweigh a textual relevance point. Project scope is the next ranking dimension, then verification. Type only affects ordering when a caller explicitly supplies `preferredTypes`; no type is treated as inherently more relevant. Freshness is measured against the newest matching item in the same retrieval, so identical query/database state produces the same ranking without a wall-clock dependency. Stable timestamp and ID ordering break remaining ties.

Near-duplicate suppression is deliberately conservative: records must have the same knowledge type and exact workspace/project scope, and must either normalize to the same token sequence or preserve one another's token order while sharing at least 90% of their distinct content tokens (with at least eight tokens). Reordered claims and changes to negation or modal/contrast words are retained. The higher-ranked entry is kept and lists suppressed IDs in its developer-facing explanation.

Candidate collection scans active records in the explicitly selected workspace/project scopes using the existing SQLite indexes and repository API. This keeps M0 storage/search semantics unchanged and avoids a schema migration; retrieval work grows with the number of active records in those scopes.

## Current limitations

- DSH integration is limited to its plugin tools, the current session identity for explicit tool-created evidence, and conservative pre-step retrieval. It does not capture every session event.
- Project identity must be configured; `cwd` is used as the workspace value without filesystem canonicalization.
- Evidence references are supplied by the caller. Git evidence discovery, file validation, and provenance verification are not implemented.
- Knowledge input is bounded through DSH tools, but the standalone M0 repository remains unbounded and neither layer scans for secrets. Do not store credentials or other sensitive values.
- `repository.search()` remains literal SQLite `LIKE` matching. M2 ranked retrieval is deterministic lexical matching, not semantic search; candidate collection scans the active records in scope.
- Knowledge is local to one SQLite database and is not synchronized.
- Automatic knowledge extraction, stale knowledge detection, and automatic lesson generation are not implemented.
- Adapter tests use the published DSH tool definitions and typed fixtures; they do not boot a complete DSH profile or model adapter.

## Roadmap

- **M0 Core storage** — completed
- **M1 DSH tools** — completed
- **M2 Intelligent deterministic retrieval** — completed; ranked local text retrieval is used by bounded pre-step context injection
- **M3 Evidence/provenance integration** — future
- **M4 Staleness detection** — future
- **M5 Automatic lessons** — future
- **M6 Git-aware project knowledge** — future

Future work includes automatic knowledge extraction, Git evidence, stale knowledge detection, automatic lesson generation, and advanced retrieval. These are not current capabilities.
