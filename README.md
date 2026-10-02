# dsh-knowledge

`dsh-knowledge` is a local, evidence-backed project knowledge layer for coding agents. It stores durable project facts, engineering decisions, and lessons in SQLite, with explicit workspace/project scope and lifecycle status.

Ordinary chat memory often retains conversational details without showing what a statement describes or where it came from. `dsh-knowledge` keeps evidence as first-class records. Explicit entries use caller-supplied evidence; opt-in M4 extraction attaches bounded session evidence to automatic candidates.

## Status

M0 core storage, M1 native DeepSeek Harness tools, M2 deterministic ranked retrieval, and M3 Git provenance with on-demand freshness checks are implemented. **The Harness adapter remains the separate `dsh-knowledge/plugin` entry point.** Storage, retrieval, Git provenance, and freshness APIs remain usable without DeepSeek Harness.

## Capabilities

- Local SQLite storage through `better-sqlite3`; no ORM or remote service.
- Create, get, list, deterministic `LIKE` search, update, archive, and supersede knowledge through the core repository.
- Normalized evidence records and workspace/project scope.
- Six DSH tools: `knowledge_add`, `knowledge_search`, `knowledge_list`, `knowledge_get`, `knowledge_archive`, and `knowledge_check_freshness`.
- `knowledge_add` opportunistically attaches the current commit and repository-relative path to clean, committed file evidence in the active session workspace.
- `knowledge_check_freshness` compares Git-backed file evidence with the current repository snapshot without modifying knowledge or Git state.
- Session evidence on explicit tool-created items when DSH provides a calling agent/session.
- The model-facing `knowledge_add` tool filters common secret patterns in content and evidence source/locator fields; this is not comprehensive scanning, and the trusted core repository does not scan secrets.
- Bounded `agent/pre-step` retrieval from the current workspace and optional configured project. It ranks relevant project entries before workspace-wide entries, prefers verified entries at equal scope, excludes archived/superseded entries, suppresses conservative near-duplicates, and injects compact context only.
- Retrieval/storage failures are logged and do not stop agent execution.

There is no automatic LLM extraction, embeddings, vector search, external API, HTTP server, or UI. Git inspection is local and read-only; the plugin never fetches or contacts a remote.

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
    automaticExtraction: true
```

The override replaces the row's full config, so include every setting you need to retain. When no project label is configured, automatic retrieval considers workspace-wide items only; the current Session API supplies `cwd` but no project identity. Tool calls default to the configured project and can pass `project: null` to select or create workspace-wide knowledge.

Automatic extraction is opt-in and defaults to `false`. Enable it with `automaticExtraction: true` in the plugin configuration. Extracted items have `creationOrigin: "automatic"` and remain candidates. They are visible to `knowledge_list` (filter with `creationOrigin: "automatic"`) but are excluded from M2 retrieval until explicitly verified. There is no model-facing verification tool.

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

## Git provenance and freshness (M3)

File evidence may include structured `gitProvenance` containing a full Git commit object ID and a repository-relative path. SQLite schema v2 stores these fields separately from evidence text; existing schema v1 evidence migrates with no Git provenance and remains valid.

The Harness `knowledge_add` tool attempts capture for explicit file evidence only when its workspace matches the active session `cwd`. Capture succeeds only for a tracked file present in `HEAD` with no relevant staged or working-tree changes. A failed or unsafe inspection does not prevent knowledge creation; the tool returns a concise capture outcome. Paths are normalized to Git `/` separators and must remain repository-relative.

`checkKnowledgeFreshness(knowledge, { workspaceDirectory })` and the `knowledge_check_freshness` tool produce per-evidence results with one of these statuses:

- **current** — the current file snapshot matches the recorded commit snapshot.
- **potentially_stale** — the file was modified, deleted, renamed away, or differs in the current working tree/index.
- **unverifiable** — provenance is absent, Git or required objects are unavailable, the operation times out, or safe comparison cannot be guaranteed.

The aggregate status describes Git-backed file evidence. Session evidence does not count as proof of file freshness, and legacy file evidence without Git provenance is reported as unverifiable. A restored file snapshot can be current even if Git history contains an intermediate edit. Freshness never changes candidate, verified, superseded, or archived status and does not prove a claim true or false. Checks are bounded, do not return diffs/source contents, do not follow renames, and never fetch missing objects.

## Knowledge health (M5)

`checkKnowledgeHealth()` and `checkKnowledgeHealthBatch()` summarize the same M3 Git comparison results; the `knowledge_health` tool checks 1–16 IDs in the active workspace/project. Checks are explicit foreground operations against live repository state. Health is not persisted or cached, and never verifies, archives, supersedes, deletes, or edits knowledge. `current` means checkable Git-backed file snapshots match; it does not mean the claim is verified or true. Session-only automatic candidates therefore report `unverifiable` without Git-backed file evidence. Health returns at most 16 per-evidence details per item; additional evidence is counted in `overflowCount` and makes the result `unverifiable` unless stale evidence takes precedence. The existing `checkKnowledgeFreshness()` API and `knowledge_check_freshness` tool remain available for compatibility.

## DSH architecture

```text
DeepSeek Harness hooks and tools
            │
            ├── session/event ── injection-ID deduplication
            ├── session/event + turn boundaries ── bounded candidate extraction (opt-in)
            ├── agent/pre-step ─ retrieval and compact context
            └── ctx.tools.register() ─ model-facing knowledge tools, freshness, and health checks
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

Before an agent request, `agent/pre-step` passes the latest user-authored text in the proposed step to the core retrieval engine. It retrieves at most four items and injects no more than 1,800 characters in a `<dsh-knowledge>` block. Stored text is quoted and labeled untrusted; directives in it should not be followed. Retrieval considers verified knowledge and explicit-origin candidates; automatic-origin candidates are excluded until explicitly verified. If a project is configured, exact-project entries rank above workspace-wide entries when textual relevance is equal; verified entries rank above candidates at equal scope. If no project is configured, retrieval is workspace-wide only. A session event observer remembers committed injected IDs in memory, scans a session transcript once to cover sessions present at plugin load, and releases state on session disposal; events are not stored in SQLite.

## Automatic candidate extraction (M4)

When enabled, the Harness adapter collects only bounded references to direct human-authored `user/message` events (`source.kind === "user"`) during a turn. After `turn/end`, a process-wide single-worker queue runs a conservative deterministic rule set outside the event callback. It recognizes a small set of explicit project decisions, project facts, corrections, durable constraints, and causal failure/fix statements. It does not infer knowledge from assistant assertions, model tool arguments, or tool success alone.

Every extracted item is stored as a candidate with automatic origin and session evidence containing the session ID, event sequence locator, and event timestamp. Conversation text is transient input: no raw transcript or excerpts are added to evidence. The event count, text length, candidate count, queue size, and shutdown wait are bounded; overflow and failures drop work without interrupting the agent task.

Before persistence, a deterministic filter rejects common API key, bearer/JWT, credential assignment, connection-string, and private-key patterns. Rejected content is not logged or redacted into a candidate. Same-scope, same-type duplicates are suppressed using the conservative M2 duplicate predicate; existing knowledge is never merged or changed. Candidates that appear to disagree with verified knowledge are not automatically promoted or superseded.

This is intentionally a narrow rules-first detector. It may miss valid knowledge and does not provide general language understanding, LLM extraction, confidence scores, or a verification workflow. Review candidates with `knowledge_list`; M2 will use one only after an explicit caller changes its status to verified.

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
- Only explicit file evidence in the active session workspace is considered for opportunistic provenance capture. Other references remain caller-supplied.
- Freshness is a bounded, on-demand snapshot comparison, not continuous monitoring. It compares committed snapshots and the current worktree; it does not detect every historical edit that was later reverted.
- Git may not safely compare files with configured clean/process filters, symlinked path components, or index flags such as `assume-unchanged` and `skip-worktree`; those checks return `unverifiable`. Provenance capture also requires an ordinary tracked worktree file and an index entry with no hidden-state flags.
- No Git network operations are performed. Missing objects are reported as unverifiable rather than fetched.
- The model-facing Harness `knowledge_add` tool filters common secret patterns in content and evidence source/locator fields. The lower-level trusted repository API does not scan secrets; the Harness filter is not comprehensive and cannot guarantee detection of every sensitive or personal value. Do not store credentials or other sensitive values.
- `repository.search()` remains literal SQLite `LIKE` matching. M2 ranked retrieval is deterministic lexical matching, not semantic search; candidate collection scans the active records in scope.
- Knowledge is local to one SQLite database and is not synchronized.
- Continuous stale-knowledge monitoring and a dedicated candidate review/verification workflow are not implemented.
- Adapter tests use the published DSH tool definitions and typed fixtures; they do not boot a complete DSH profile or model adapter.

## Roadmap

- **M0 Core storage** — completed
- **M1 DSH tools** — completed
- **M2 Intelligent deterministic retrieval** — completed; ranked local text retrieval is used by bounded pre-step context injection
- **M3 Git-aware provenance and on-demand freshness** — completed
- **M4 Automatic knowledge and lesson candidate extraction** — implemented; opt-in and candidate-only
- **M5 Knowledge health and staleness visibility** — explicit, bounded, live Git checks; no background monitoring or lifecycle changes
- **M6 Candidate review workflow and richer Git-aware knowledge** — future

Future work includes continuous stale-knowledge monitoring and a dedicated candidate review workflow. These are not current capabilities.
