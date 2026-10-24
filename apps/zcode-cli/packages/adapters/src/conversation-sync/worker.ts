import {
  ConversationSyncError,
  syncScopeSchema,
  type ConversationSyncStore,
  type Logger,
  type SyncScope,
  type SyncVersion,
} from "@zcode/contracts";
import { canonical } from "./canonical.js";
import { receiveOperation, type ConversationSyncOutbox } from "./outbox.js";

export interface SyncCheckpointSource {
  /** Trusted native owner supplies persisted changes, never an in-memory notification watermark. */
  changes(after: number): Promise<{
    cursor: number;
    items: Array<{
      workspacePurpose: "conversation" | "directory" | "unknown";
      hasLocalDirectory: boolean;
      session: string;
      version: SyncVersion;
    }>;
  }>;
}
/** One worker is permanently bound to one authenticated scope; switching accounts creates a new worker. */
export function createConversationSyncWorker(options: {
  scope: SyncScope;
  source: SyncCheckpointSource;
  outbox: ConversationSyncOutbox;
  center: ConversationSyncStore;
  logger: Logger;
  unconfirmed?(session: string, code: string): void;
  currentScope(): SyncScope | null;
}) {
  let running: Promise<void> | null = null;
  function scopeKey(scope: SyncScope | null) {
    const result = syncScopeSchema.safeParse(scope);
    return result.success ? canonical(result.data) : null;
  }
  const bound = scopeKey(options.scope);
  if (bound === null) throw new ConversationSyncError("scope");
  function checkScope() {
    if (scopeKey(options.currentScope()) !== bound) throw new ConversationSyncError("scope");
  }
  async function run() {
    checkScope();
    const after = options.outbox.cursor(options.scope);
    const changes = await options.source.changes(after);
    checkScope();
    const requests = changes.items
      .filter((item) => item.workspacePurpose === "conversation" && !item.hasLocalDirectory)
      .map((item) => receiveOperation(item.session, item.version));
    options.outbox.capture(options.scope, changes.cursor, after, requests);
    const blockedSessions = new Set<string>();
    let firstRejection: ConversationSyncError | undefined;
    for (const request of options.outbox.pending(options.scope)) {
      checkScope();
      if (blockedSessions.has(request.session)) continue;
      const rejected=options.outbox.rejection(options.scope,request.session);
      if(rejected) {blockedSessions.add(request.session);options.unconfirmed?.(request.session,rejected.code);firstRejection??=new ConversationSyncError(rejected.code);continue;}
      let receipt;
      try {
        receipt = await options.center.execute(options.scope, request);
      } catch (cause: unknown) {
        const code = cause instanceof ConversationSyncError ? cause.code : "transport";
        options.unconfirmed?.(request.session, code);
        options.logger.warn("Conversation checkpoint not acknowledged", {
          event: "conversation.sync.ack",
          operationId: request.operation,
          sessionId: request.session,
          status: "failed",
          outcome: "unconfirmed",
          code,
        });
        // 限额拒绝不应阻塞其它会话；同一会话的后继仍须等待准确前序确认。
        if (cause instanceof ConversationSyncError && ["limit", "invalid", "conflict", "blocked", "stale", "not_found"].includes(code)) {
          // 永久拒绝只阻塞同一会话的因果后继，不得饿死其他会话；原操作仍保留供修复核对。
          blockedSessions.add(request.session);
          firstRejection ??= cause;
          if(code!=="limit") options.outbox.reject(options.scope,request.session,request.operation,code as "invalid"|"conflict"|"blocked"|"stale"|"not_found");
          continue;
        }
        throw cause;
      }
      // 登录变化期间收到旧回执，不把它投影到新账号；下次原账号再核对原操作。
      checkScope();
      options.outbox.acknowledge(options.scope, receipt);
      options.logger.info("Conversation checkpoint acknowledged", {
        event: "conversation.sync.ack",
        operationId: request.operation,
        sessionId: request.session,
        revision: receipt.state.revision,
        status: "completed",
        outcome: "server_saved",
      });
    }
    if (firstRejection) throw firstRejection;
  }
  return {
    reconcile(): Promise<void> {
      if (!running)
        running = run().finally(() => {
          running = null;
        });
      return running;
    },
  };
}
