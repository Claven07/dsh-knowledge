# dsh-knowledge

`dsh-knowledge` is a small local knowledge storage library for coding agents. It stores project facts, engineering decisions, and lessons alongside evidence that can point to a session, file, or Git source.

It exists to make project knowledge reviewable and traceable. Unlike ordinary chat memory, each item has an explicit type, project scope, lifecycle status, and first-class evidence records. The storage layer is deterministic and usable on its own.

## M0 capabilities

- Local SQLite storage using `better-sqlite3`
- Create, retrieve, filter, search, update, archive, and supersede knowledge
- Normalized evidence records with optional locators
- Workspace and project scoping
- Validated lifecycle transitions
- Deterministic text search over knowledge content

**DeepSeek Harness integration is not implemented yet.** M0 does not discover evidence automatically or connect to agent sessions.

## Installation

For development from this repository:

```sh
npm install
```

After publication, install the package with `npm install dsh-knowledge`. The library requires Node.js 20 or newer.

## Usage

```ts
import { KnowledgeRepository, KnowledgeStore } from "dsh-knowledge";

const store = new KnowledgeStore(".dsh-knowledge/knowledge.sqlite");
const knowledge = new KnowledgeRepository(store);

const item = knowledge.create({
  type: "decision",
  content: "Use SQLite for local project knowledge storage.",
  scope: { workspace: "my-workspace", project: "my-project" },
  evidence: [
    {
      type: "file",
      source: "docs/architecture.md",
      locator: "Storage section",
      timestamp: new Date().toISOString(),
    },
  ],
});

const matches = knowledge.search("SQLite", {
  workspace: "my-workspace",
  project: "my-project",
});

store.close();
```

`create()` assigns a UUID, timestamps the item, and starts it as a `candidate`. A candidate can become `verified`; a verified item can be superseded by another verified item in the same scope; superseded items can be archived. Candidates and verified items can also be archived directly.

## Architecture

- `KnowledgeStore` opens the SQLite database, configures it, and creates or upgrades the schema.
- `KnowledgeRepository` validates inputs, applies lifecycle rules, persists knowledge and evidence transactionally, and reconstructs domain objects.
- `src/knowledge/types.ts` defines the public domain and input types.

Knowledge metadata and evidence are stored in separate relational tables. Search uses escaped SQLite `LIKE` matching on `content`; results have a stable newest-first ordering.

## Current limitations

- Storage is local to one SQLite database; there is no sync or cloud storage.
- Search is literal substring matching, with SQLite's built-in case handling; there are no embeddings or semantic retrieval.
- Evidence must be supplied by the caller. There is no automatic extraction, freshness checking, or provenance verification.
- There is no DSH plugin, tool registration, retrieval/context injection, server, or UI.

## Roadmap

1. **M0 Core storage** — local domain and SQLite foundation
2. **M1 DSH tools** — expose explicit knowledge operations to DeepSeek Harness
3. **M2 Automatic retrieval/context injection** — retrieve relevant project knowledge for agent work
4. **M3 Evidence/provenance integration** — connect knowledge to session, file, and Git evidence
5. **M4 Staleness detection** — identify knowledge that may no longer be current
6. **M5 Automatic lessons** — propose lessons from agent work for review
7. **M6 Git-aware project knowledge** — use repository state and history to scope and maintain knowledge

Only M0 is implemented.
