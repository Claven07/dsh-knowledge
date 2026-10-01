import { defineTool } from "@deepseek-ai/dsh-tools";
import type { InferValue, ToolRuntime, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import { captureFileProvenance, MAX_GIT_EVIDENCE_CHECKS } from "../knowledge/git.js";
import { checkKnowledgeFreshness } from "../knowledge/freshness.js";
import type {
  Evidence,
  EvidenceType,
  Knowledge,
  KnowledgeStatus,
  KnowledgeType,
} from "../knowledge/types.js";

const KNOWLEDGE_TYPES = ["fact", "decision", "lesson"] as const;
const KNOWLEDGE_STATUSES = ["candidate", "verified", "superseded", "archived"] as const;
const EVIDENCE_TYPES = ["session", "file", "git"] as const;
const DEFAULT_TOOL_RESULT_LIMIT = 10;
const MAX_TOOL_RESULT_LIMIT = 20;
const MAX_CONTENT_CHARS = 8_000;
const MAX_QUERY_CHARS = 256;
const MAX_WORKSPACE_CHARS = 512;
const MAX_PROJECT_CHARS = 128;
const MAX_EVIDENCE_ITEMS = 16;
const MAX_EVIDENCE_FIELD_CHARS = 256;
const MAX_ID_CHARS = 128;
const LIST_CONTENT_LIMIT = 280;
const GET_CONTENT_LIMIT = 1_200;
const MAX_RETURNED_EVIDENCE = 8;
const MAX_CAPTURE_FILES_PER_ADD = 8;
const MAX_CAPTURE_BUDGET_MS = 5_000;
const MAX_GIT_COMMAND_TIMEOUT_MS = 1_500;

const evidenceSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: EVIDENCE_TYPES, required: true },
    source: { type: "string", required: true },
    sourceTruncated: { type: "boolean" },
    locator: { type: "string" },
    locatorTruncated: { type: "boolean" },
  },
} as const;

const knowledgeSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    type: { type: "string", enum: KNOWLEDGE_TYPES, required: true },
    content: { type: "string", required: true },
    contentTruncated: { type: "boolean", required: true },
    workspace: { type: "string", required: true },
    workspaceTruncated: { type: "boolean" },
    project: { type: "string" },
    projectTruncated: { type: "boolean" },
    status: { type: "string", enum: KNOWLEDGE_STATUSES, required: true },
    evidence: { type: "array", items: evidenceSummarySchema },
  },
} as const;

type KnowledgeSummary = InferValue<typeof knowledgeSummarySchema>;

const singleItemOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: true, required: true },
        item: {
          oneOf: [knowledgeSummarySchema, { type: "null" }],
          required: true,
        },
        provenanceCapture: {
          type: "object",
          additionalProperties: false,
          properties: {
            attempted: { type: "integer", required: true },
            captured: { type: "integer", required: true },
            skipped: { type: "integer", required: true },
            warnings: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  evidenceIndex: { type: "integer", required: true },
                  reason: { type: "string", required: true },
                },
              },
              required: true,
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: false, required: true },
        error: { type: "string", required: true },
      },
    },
  ],
} as const;

const freshnessOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: true, required: true },
        knowledgeStatus: { type: "string", enum: KNOWLEDGE_STATUSES },
        report: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                knowledgeId: { type: "string", required: true },
                checkedAt: { type: "string", required: true },
                status: { type: "string", enum: ["current", "potentially_stale", "unverifiable"], required: true },
                evidenceCount: { type: "integer", required: true },
                evidenceTruncated: { type: "boolean", required: true },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      evidenceIndex: { type: "integer", required: true },
                      status: { type: "string", enum: ["current", "potentially_stale", "unverifiable"], required: true },
                      reason: { type: "string" },
                    },
                  },
                  required: true,
                },
              },
            },
            { type: "null" },
          ],
          required: true,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: false, required: true },
        error: { type: "string", required: true },
      },
    },
  ],
} as const;

const listOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: true, required: true },
        count: { type: "integer", required: true },
        items: { type: "array", items: knowledgeSummarySchema, required: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: false, required: true },
        error: { type: "string", required: true },
      },
    },
  ],
} as const;

export type KnowledgeToolConfig = {
  project?: string;
};

export type KnowledgeRepositoryProvider = () => KnowledgeRepository | null;

export type KnowledgeToolRegistrar = Pick<ToolRuntime, "register">;

/** Register the model-facing knowledge tools in the current Cordis fiber. */
export function registerKnowledgeTools(
  tools: KnowledgeToolRegistrar,
  getRepository: KnowledgeRepositoryProvider,
  config: KnowledgeToolConfig,
): void {
  const addTool = defineTool({
    name: "knowledge_add",
    description: "Store one project fact, engineering decision, or lesson with optional evidence.",
    parameters: {
      type: {
        type: "string",
        enum: KNOWLEDGE_TYPES,
        required: true,
        description: "Knowledge category.",
      },
      content: {
        type: "string",
        required: true,
        description: `A concise, durable, non-sensitive project statement (maximum ${MAX_CONTENT_CHARS} characters). Never store credentials or secrets.`,
      },
      workspace: {
        type: "string",
        required: true,
        description: "Workspace scope. Use the active session cwd when it is available.",
      },
      project: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description: "Exact project scope; omit for the configured project (or workspace-wide if none is configured); use null to select workspace-wide knowledge explicitly.",
      },
      evidence: {
        type: "array",
        description: `Optional evidence references (maximum ${MAX_EVIDENCE_ITEMS}); timestamps are assigned when stored.`,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: EVIDENCE_TYPES, required: true },
            source: { type: "string", required: true },
            locator: { type: "string" },
          },
        },
      },
    },
    output: {
      schema: singleItemOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }

      validateBoundedText(args.content, "content", MAX_CONTENT_CHARS);
      validateBoundedText(args.workspace, "workspace", MAX_WORKSPACE_CHARS);
      validateEvidence(args.evidence ?? []);

      const createdAt = new Date().toISOString();
      const capture: {
        attempted: number;
        captured: number;
        skipped: number;
        warnings: Array<{ evidenceIndex: number; reason: string }>;
      } = { attempted: 0, captured: 0, skipped: 0, warnings: [] };
      const captureStartedAt = Date.now();
      let captureSlots = 0;
      const sessionWorkspace = exec.agent?.session.header.cwd;
      const evidence: Evidence[] = (args.evidence ?? []).map((item) => {
        const entry: Evidence = {
          type: item.type as EvidenceType,
          source: item.source,
          timestamp: createdAt,
        };
        if (item.locator !== undefined) {
          entry.locator = item.locator;
        }
        return entry;
      });

      for (let index = 0; index < evidence.length; index += 1) {
        const entry = evidence[index]!;
        if (entry.type !== "file") {
          continue;
        }
        capture.attempted += 1;
        let skippedReason: string | undefined;
        if (typeof sessionWorkspace !== "string" || sessionWorkspace.length === 0) {
          skippedReason = "missing_session_workspace";
        } else if (args.workspace !== sessionWorkspace) {
          skippedReason = "workspace_mismatch";
        } else if (captureSlots >= MAX_CAPTURE_FILES_PER_ADD) {
          skippedReason = "evidence_limit_exceeded";
        } else {
          const remaining = MAX_CAPTURE_BUDGET_MS - (Date.now() - captureStartedAt);
          if (remaining < 1) {
            skippedReason = "operation_budget_exceeded";
          } else {
            captureSlots += 1;
            const result = await captureFileProvenance({
              workspaceDirectory: sessionWorkspace,
              filePath: entry.source,
              commandTimeoutMs: Math.min(MAX_GIT_COMMAND_TIMEOUT_MS, remaining),
              operationBudgetMs: remaining,
            });
            if (result.status === "captured") {
              entry.gitProvenance = result.provenance;
              capture.captured += 1;
            } else {
              skippedReason = result.reason;
            }
          }
        }
        if (skippedReason !== undefined) {
          capture.skipped += 1;
          capture.warnings.push({ evidenceIndex: index, reason: skippedReason });
        }
      }

      const sessionId = exec.agent?.session.id;
      if (
        sessionId !== undefined &&
        !evidence.some((item) => item.type === "session" && item.source === sessionId)
      ) {
        evidence.push({ type: "session", source: sessionId, timestamp: createdAt });
      }

      const project = resolveProject(args.project, config.project);
      const item = repository.create({
        type: args.type as KnowledgeType,
        content: args.content,
        scope: {
          workspace: args.workspace,
          ...(project === null ? {} : { project }),
        },
        evidence,
      });
      return {
        ok: true,
        item: summarize(item, GET_CONTENT_LIMIT, false),
        ...(capture.attempted === 0 ? {} : { provenanceCapture: capture }),
      };
    },
  });

  const searchTool = defineTool({
    name: "knowledge_search",
    description: "Find stored project knowledge by literal content text and optional scope or lifecycle filters.",
    parameters: {
      query: { type: "string", required: true, description: "Text to match in knowledge content." },
      workspace: { type: "string", description: "Workspace filter; defaults to the active session cwd." },
      project: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description: "Exact project filter; omit for the configured project (or workspace-wide if none is configured); use null to select workspace-wide entries explicitly.",
      },
      type: { type: "string", enum: KNOWLEDGE_TYPES, description: "Optional knowledge category." },
      status: { type: "string", enum: KNOWLEDGE_STATUSES, description: "Optional lifecycle status." },
      limit: { type: "integer", description: "Maximum results, capped at 20 (default 10)." },
    },
    output: {
      schema: listOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }
      const workspace = resolveWorkspace(args.workspace, exec);
      if (workspace === undefined) {
        return missingWorkspace();
      }
      const project = resolveProject(args.project, config.project);
      validateBoundedText(args.query, "query", MAX_QUERY_CHARS, true);
      const options = {
        workspace,
        project,
        ...(args.type === undefined ? {} : { type: args.type as KnowledgeType }),
        ...(args.status === undefined ? {} : { status: args.status as KnowledgeStatus }),
        limit: boundedLimit(args.limit),
      };
      const items = repository.search(args.query, options);
      return {
        ok: true,
        count: items.length,
        items: items.map((item) => summarize(item, LIST_CONTENT_LIMIT, false)),
      };
    },
  });

  const listTool = defineTool({
    name: "knowledge_list",
    description: "List project knowledge with optional workspace, project, type, and status filters.",
    parameters: {
      workspace: { type: "string", description: "Workspace filter; defaults to the active session cwd." },
      project: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description: "Exact project filter; omit for the configured project (or workspace-wide if none is configured); use null to select workspace-wide entries explicitly.",
      },
      type: { type: "string", enum: KNOWLEDGE_TYPES, description: "Optional knowledge category." },
      status: { type: "string", enum: KNOWLEDGE_STATUSES, description: "Optional lifecycle status." },
      limit: { type: "integer", description: "Maximum results, capped at 20 (default 10)." },
    },
    output: {
      schema: listOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }
      const workspace = resolveWorkspace(args.workspace, exec);
      if (workspace === undefined) {
        return missingWorkspace();
      }
      const project = resolveProject(args.project, config.project);
      const options = {
        workspace,
        project,
        ...(args.type === undefined ? {} : { type: args.type as KnowledgeType }),
        ...(args.status === undefined ? {} : { status: args.status as KnowledgeStatus }),
        limit: boundedLimit(args.limit),
      };
      const items = repository.list(options);
      return {
        ok: true,
        count: items.length,
        items: items.map((item) => summarize(item, LIST_CONTENT_LIMIT, false)),
      };
    },
  });

  const getTool = defineTool({
    name: "knowledge_get",
    description: "Get one knowledge item by ID within the current or explicitly selected workspace.",
    parameters: {
      id: { type: "string", required: true, description: "Knowledge ID." },
      workspace: { type: "string", description: "Workspace filter; defaults to the active session cwd." },
      project: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description: "Exact project filter; omit for the configured project (or workspace-wide if none is configured); use null to select workspace-wide scope explicitly.",
      },
    },
    output: {
      schema: singleItemOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }
      const workspace = resolveWorkspace(args.workspace, exec);
      if (workspace === undefined) {
        return missingWorkspace();
      }
      validateBoundedText(args.id, "id", MAX_ID_CHARS);
      const item = repository.getById(args.id);
      if (!isInScope(item, workspace, resolveProject(args.project, config.project))) {
        return { ok: true, item: null };
      }
      return { ok: true, item: item === null ? null : summarize(item, GET_CONTENT_LIMIT, true) };
    },
  });

  const archiveTool = defineTool({
    name: "knowledge_archive",
    description: "Archive one knowledge item by ID within the current or explicitly selected workspace.",
    parameters: {
      id: { type: "string", required: true, description: "Knowledge ID." },
      workspace: { type: "string", description: "Workspace filter; defaults to the active session cwd." },
      project: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description: "Exact project filter; omit for the configured project (or workspace-wide if none is configured); use null to select workspace-wide scope explicitly.",
      },
    },
    output: {
      schema: singleItemOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }
      const workspace = resolveWorkspace(args.workspace, exec);
      if (workspace === undefined) {
        return missingWorkspace();
      }
      validateBoundedText(args.id, "id", MAX_ID_CHARS);
      const existing = repository.getById(args.id);
      if (!isInScope(existing, workspace, resolveProject(args.project, config.project))) {
        return { ok: true, item: null };
      }
      const item = repository.archive(args.id);
      return { ok: true, item: summarize(item, GET_CONTENT_LIMIT, false) };
    },
  });

  const freshnessTool = defineTool({
    name: "knowledge_check_freshness",
    description: "Check whether Git-backed file evidence still matches the active workspace snapshot. This is a read-only signal and does not change knowledge status.",
    parameters: {
      id: { type: "string", required: true, description: "Knowledge ID in the active workspace and configured project scope." },
    },
    output: {
      schema: freshnessOutputSchema,
      render: (_args, value) => [
        { type: "text", text: renderJson(value) },
      ],
    },
    async execute(args, exec) {
      const repository = getRepository();
      if (repository === null) {
        return unavailable();
      }
      const workspace = resolveWorkspace(undefined, exec);
      if (workspace === undefined) {
        return missingWorkspace();
      }
      validateBoundedText(args.id, "id", MAX_ID_CHARS);
      const item = repository.getById(args.id);
      if (!isInScope(item, workspace, resolveProject(undefined, config.project))) {
        return { ok: true, report: null };
      }

      const report = await checkKnowledgeFreshness(item, { workspaceDirectory: workspace });
      const visibleEvidence = report.evidence.slice(0, MAX_GIT_EVIDENCE_CHECKS);
      return {
        ok: true,
        knowledgeStatus: item.status,
        report: {
          knowledgeId: report.knowledgeId,
          checkedAt: report.checkedAt,
          status: report.status,
          evidenceCount: report.evidence.length,
          evidenceTruncated: report.evidence.length > visibleEvidence.length,
          evidence: visibleEvidence.map((entry) => ({
            evidenceIndex: entry.evidenceIndex,
            status: entry.status,
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          })),
        },
      };
    },
  });

  for (const tool of [addTool, searchTool, listTool, getTool, archiveTool, freshnessTool]) {
    tools.register(tool);
  }
}

function resolveWorkspace(
  requestedWorkspace: string | undefined,
  exec: ToolRunContext,
): string | undefined {
  const workspace = requestedWorkspace ?? exec.agent?.session.header.cwd;
  if (workspace === undefined || workspace.trim().length === 0) {
    return undefined;
  }
  validateBoundedText(workspace, "workspace", MAX_WORKSPACE_CHARS);
  return workspace;
}

function isInScope(
  item: Knowledge | null,
  workspace: string,
  project: string | null,
): item is Knowledge {
  if (item === null || item.scope.workspace !== workspace) {
    return false;
  }
  return project === null
    ? item.scope.project === undefined
    : item.scope.project === project;
}

function resolveProject(
  requestedProject: string | null | undefined,
  configuredProject: string | undefined,
): string | null {
  const project = requestedProject === undefined ? configuredProject : requestedProject;
  if (project === undefined || project === null) {
    return null;
  }
  validateBoundedText(project, "project", MAX_PROJECT_CHARS);
  return project;
}

function validateEvidence(evidence: readonly { source: string; locator?: string }[]): void {
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new RangeError(`evidence must contain at most ${MAX_EVIDENCE_ITEMS} items.`);
  }
  evidence.forEach((item, index) => {
    validateBoundedText(item.source, `evidence[${index}].source`, MAX_EVIDENCE_FIELD_CHARS);
    if (item.locator !== undefined) {
      validateBoundedText(item.locator, `evidence[${index}].locator`, MAX_EVIDENCE_FIELD_CHARS);
    }
  });
}

function validateBoundedText(
  value: string,
  field: string,
  maxLength: number,
  allowEmpty = false,
): void {
  if (value.length > maxLength) {
    throw new RangeError(`${field} must be at most ${maxLength} characters.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TOOL_RESULT_LIMIT;
  }
  return Math.min(MAX_TOOL_RESULT_LIMIT, Math.max(1, Math.floor(limit)));
}

function summarize(
  item: Knowledge,
  contentLimit: number,
  includeEvidence: boolean,
): KnowledgeSummary {
  const content = item.content.slice(0, contentLimit);
  const summary: KnowledgeSummary = {
    id: item.id,
    type: item.type,
    content,
    contentTruncated: item.content.length > contentLimit,
    workspace: item.scope.workspace.slice(0, MAX_WORKSPACE_CHARS),
    status: item.status,
  };
  if (item.scope.workspace.length > MAX_WORKSPACE_CHARS) {
    summary.workspaceTruncated = true;
  }
  if (item.scope.project !== undefined) {
    summary.project = item.scope.project.slice(0, MAX_PROJECT_CHARS);
    if (item.scope.project.length > MAX_PROJECT_CHARS) {
      summary.projectTruncated = true;
    }
  }
  if (includeEvidence) {
    summary.evidence = item.evidence.slice(0, MAX_RETURNED_EVIDENCE).map((entry) => {
      const result: { type: EvidenceType; source: string; locator?: string } = {
        type: entry.type,
        source: entry.source.slice(0, MAX_EVIDENCE_FIELD_CHARS),
      };
      if (entry.source.length > MAX_EVIDENCE_FIELD_CHARS) {
        Object.assign(result, { sourceTruncated: true });
      }
      if (entry.locator !== undefined) {
        result.locator = entry.locator.slice(0, MAX_EVIDENCE_FIELD_CHARS);
        if (entry.locator.length > MAX_EVIDENCE_FIELD_CHARS) {
          Object.assign(result, { locatorTruncated: true });
        }
      }
      return result;
    });
  }
  return summary;
}

function unavailable(): { ok: false; error: string } {
  return { ok: false, error: "Knowledge storage is unavailable." };
}

function missingWorkspace(): { ok: false; error: string } {
  return { ok: false, error: "Workspace is unavailable; provide an explicit workspace scope." };
}

function renderJson(value: unknown): string {
  return JSON.stringify(value) ?? "{}";
}
