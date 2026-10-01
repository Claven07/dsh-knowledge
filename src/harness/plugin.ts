import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { KnowledgeInjectionTracker } from "./events.js";
import { observeKnowledgeExtraction } from "./extraction.js";
import { createKnowledgePreStepHandler } from "./retrieval.js";
import { registerKnowledgeTools } from "./tools.js";

export const name = "dsh-knowledge";
export const inject = ["tools"];

export interface Config {
  /** Absolute or current-working-directory-relative SQLite path; defaults below the DSH home. */
  databasePath?: string;
  /** Explicit DSH home override; otherwise the official DSH_HOME rules apply. */
  dshHome?: string;
  /** Optional project label because SessionHeader currently supplies cwd, not project identity. */
  project?: string;
  /** Capture conservative candidate knowledge from direct user messages; disabled by default. */
  automaticExtraction?: boolean;
}

export const Config: z<Config> = z.object({
  databasePath: z.string().min(1),
  dshHome: z.string().min(1),
  project: z.string().min(1),
  automaticExtraction: z.boolean().default(false),
});

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("dsh-knowledge");
  let store: KnowledgeStore | undefined;
  let repository: KnowledgeRepository | null = null;
  let disposeExtraction: (() => Promise<void>) | undefined;

  // Keep cleanup order explicit: stop extraction and wait briefly before closing SQLite.
  ctx.effect(() => async () => {
    try {
      await disposeExtraction?.();
    } finally {
      store?.close();
    }
  }, "dsh-knowledge.store()");

  try {
    const databasePath = config.databasePath ?? join(resolveDshHome(config.dshHome), "knowledge", "knowledge.sqlite");
    store = new KnowledgeStore(databasePath);
    repository = new KnowledgeRepository(store);
  } catch (error: unknown) {
    logger.warn(`Knowledge storage could not be opened; tools remain registered but unavailable: ${errorMessage(error)}`);
  }

  const getRepository = (): KnowledgeRepository | null => repository;
  if (config.automaticExtraction === true) {
    try {
      const extraction = observeKnowledgeExtraction(ctx, {
        getRepository,
        project: config.project,
        onQueueFull: () => logger.warn("Automatic knowledge extraction skipped (queue_full)."),
        onFailure: () => logger.warn("Automatic knowledge extraction skipped (processing_failure)."),
      });
      disposeExtraction = () => extraction.dispose();
    } catch {
      logger.warn("Automatic knowledge extraction could not be initialized; continuing without extraction.");
    }
  }
  const tracker = new KnowledgeInjectionTracker();
  tracker.observe(ctx);

  registerKnowledgeTools(ctx.tools, getRepository, config);
  ctx.on(
    "agent/pre-step",
    createKnowledgePreStepHandler(getRepository, tracker, {
      project: config.project,
      onError: (error) => {
        logger.warn(`Knowledge retrieval failed; continuing without injected context: ${errorMessage(error)}`);
      },
    }),
    { prepend: true },
  );
}

/** Convenience namespace for direct ESM consumers; DSH loads the named exports above. */
const plugin = { name, inject, Config, apply };
export default plugin;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
