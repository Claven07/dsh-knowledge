import type { Context } from "@deepseek-ai/cordis";
import type { ContextFormed, MessageSourceMap } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

export const KNOWLEDGE_CONTEXT_SOURCE = "plugin:dsh-knowledge" as const;

export type KnowledgeContextSource = {
  kind: typeof KNOWLEDGE_CONTEXT_SOURCE;
  knowledgeIds: string[];
} & ContextFormed;

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:dsh-knowledge": KnowledgeContextSource;
  }
}

/** Tracks injected item IDs for live sessions without writing session events to SQLite. */
export class KnowledgeInjectionTracker {
  private readonly seenBySession = new WeakMap<Session, Set<string>>();
  private readonly scannedSessions = new WeakSet<Session>();

  observe(context: Context): void {
    context.on("session/event", (session, event) => {
      this.observeEvent(session, event);
    });
    context.on("session/disposed", (session) => {
      this.release(session);
    });
  }

  observeEvent(session: Session, event: SessionEvent): void {
    if (event.type !== "user/message") {
      return;
    }

    this.recordSource(session, event.data.source);
  }

  seenFor(session: Session): ReadonlySet<string> {
    if (!this.scannedSessions.has(session)) {
      // This also covers a live session that existed before the plugin was loaded.
      for (const message of session.deriveMessages()) {
        this.recordSource(session, message.source);
      }
      this.scannedSessions.add(session);
    }

    return new Set(this.seenBySession.get(session));
  }

  release(session: Session): void {
    this.seenBySession.delete(session);
    this.scannedSessions.delete(session);
  }

  record(session: Session, ids: readonly string[]): void {
    const seen = this.seenBySession.get(session) ?? new Set<string>();
    for (const id of ids) {
      if (id.length > 0) {
        seen.add(id);
      }
    }
    this.seenBySession.set(session, seen);
  }

  private recordSource(
    session: Session,
    source: MessageSourceMap[keyof MessageSourceMap],
  ): void {
    if (source.kind !== KNOWLEDGE_CONTEXT_SOURCE) {
      return;
    }

    this.record(session, source.knowledgeIds);
  }
}
