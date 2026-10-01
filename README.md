# dsh-knowledge

`dsh-knowledge` is a local, evidence-backed project knowledge layer for coding agents. It stores durable project facts, engineering decisions, and lessons in SQLite, with explicit workspace/project scope and lifecycle status.

Ordinary chat memory often retains conversational details without showing what a statement describes or where it came from. `dsh-knowledge` keeps evidence as first-class records so future integrations can connect knowledge to sessions, files, and Git history. Evidence is caller-supplied in M0/M1; automatic discovery is not implemented.

## Status

M0 core storage and M1 native DeepSeek Harness tools/context retrieval are implemented. **DeepSeek Harness integration was not part of M0; it is implemented as the separate `dsh-knowledge/plugin` entry point in M1.** The storage/domain API remains usable without DeepSeek Harness.

## Capabilities

- Local SQLite storage through `better-sqlite3`; no ORM or remote service.
- Create, get, list, deterministic `LIKE` search, update, archive, and supersede knowledge through the core repository.
- Normalized evidence records and workspace/project scope.
- Five DSH tools: `knowledge_add`, `knowledge_search`, `knowledge_list`, `knowledge_get`, and `knowledge_archive`.
- Session evidence on explicit tool-created items when DSH provides a calling agent/session.
- Bounded model inputs and results; the add tool advises against persisting credentials or secrets (there is no secret scanner).
- Bounded `agent/pre-step` retrieval from the current workspace and optional configured project. It prioritizes exact-project entries and verified status, excludes archived/superseded entries, and injects compact context only.
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
import { KnowledgeRepository, KnowledgeStore } from "dsh-knowledge";

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

store.close();
```

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

Before an agent request, `agent/pre-step` takes a few non-generic keywords (at most 64 characters each) from the latest user message in the proposed step and searches deterministically with the existing repository `LIKE` search. It retrieves at most four items and injects no more than 1,800 characters in a `<dsh-knowledge>` block. Stored text is quoted and labeled untrusted; directives in it should not be followed. Verified items rank ahead of candidates, and exact-project items rank ahead of workspace-wide items within each status. If no project is configured, retrieval is workspace-wide only. A session event observer remembers committed injected IDs in memory, scans a session transcript once to cover sessions present at plugin load, and releases state on session disposal; events are not stored in SQLite.

## Current limitations

- DSH integration is limited to its plugin tools, the current session identity for explicit tool-created evidence, and conservative pre-step retrieval. It does not capture every session event.
- Project identity must be configured; `cwd` is used as the workspace value without filesystem canonicalization.
- Evidence references are supplied by the caller. Git evidence discovery, file validation, and provenance verification are not implemented.
- Knowledge input is bounded through DSH tools, but the standalone M0 repository remains unbounded and neither layer scans for secrets. Do not store credentials or other sensitive values.
- Search is literal, deterministic SQLite `LIKE` matching. It is not semantic search.
- Knowledge is local to one SQLite database and is not synchronized.
- Automatic knowledge extraction, stale knowledge detection, and automatic lesson generation are not implemented.
- Adapter tests use the published DSH tool definitions and typed fixtures; they do not boot a complete DSH profile or model adapter.

## Roadmap

- **M0 Core storage** — completed
- **M1 DSH tools** — completed
- **M2 Automatic retrieval/context injection** — implemented in M1 as bounded deterministic pre-step retrieval; future work may improve its policy
- **M3 Evidence/provenance integration** — future
- **M4 Staleness detection** — future
- **M5 Automatic lessons** — future
- **M6 Git-aware project knowledge** — future

Future work includes automatic knowledge extraction, Git evidence, stale knowledge detection, automatic lesson generation, and advanced retrieval. These are not current capabilities.
