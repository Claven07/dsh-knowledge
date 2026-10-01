import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { KnowledgeInjectionTracker } from "./events.js";
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
}

export const Config: z<Config> = z.object({
  databasePath: z.string().min(1),
  dshHome: z.string().min(1),
  project: z.string().min(1),
});

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("dsh-knowledge");
  let store: KnowledgeStore | undefined;
  let repository: KnowledgeRepository | null = null;

  ctx.effect(() => () => store?.close(), "dsh-knowledge.store()");

  try {
    const databasePath = config.databasePath ?? join(resolveDshHome(config.dshHome), "knowledge", "knowledge.sqlite");
    store = new KnowledgeStore(databasePath);
    repository = new KnowledgeRepository(store);
  } catch (error: unknown) {
    logger.warn(`Knowledge storage could not be opened; tools remain registered but unavailable: ${errorMessage(error)}`);
  }

  const getRepository = (): KnowledgeRepository | null => repository;
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
