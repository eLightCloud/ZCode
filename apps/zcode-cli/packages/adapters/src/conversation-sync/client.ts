import {
  ConversationSyncError,
  syncReceiptSchema,
  syncErrorSchema,
  syncRequestSchema,
  syncScopeSchema,
  syncStateSchema,
  syncVersionSchema,
  syncListSchema,
  type ConversationSyncStore,
  type HttpClientPort,
  type SyncScope,
  type TraceContext,
} from "@zcode/contracts";
import { canonical, digest } from "./canonical.js";
import {
  conversationHistorySchema,
  conversationContinuationRecordSchema,
  conversationFileSchema,
} from "@zcode/shared";
import { z } from "zod";

/** Storage transport only. Privileged selection/barrier commands have no public HTTP mutation route. */
export function createConversationSyncHttpClient(options: {
  url: string;
  scope: SyncScope;
  httpClient: HttpClientPort;
  credential(): Promise<string>;
  currentScope(): SyncScope | null;
  timeoutMs: number;
  maxResponseBytes: number;
  trace: TraceContext;
  /** Explicit isolated-test loopback only; normal transport requires HTTPS. */
  allowLoopbackHttp?: boolean;
  /** Exact private origin supplied by the trusted launcher, never an RPC/browser field. */
  trustedHttpOrigin?: string;
}): ConversationSyncStore {
  const base = new URL(options.url);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ((options.allowLoopbackHttp && isLoopback) || options.trustedHttpOrigin === base.origin)
      )) ||
    ![options.timeoutMs, options.maxResponseBytes].every((n) => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new ConversationSyncError("invalid");
  }
  const bound = canonical(syncScopeSchema.parse(options.scope));
  function checkScope(scope: SyncScope) {
    const supplied = syncScopeSchema.safeParse(scope);
    const current = syncScopeSchema.safeParse(options.currentScope());
    if (
      !supplied.success ||
      !current.success ||
      canonical(supplied.data) !== bound ||
      canonical(current.data) !== bound
    )
      throw new ConversationSyncError("scope");
  }
  async function request(
    scope: SyncScope,
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ): Promise<unknown> {
    checkScope(scope);
    const credential = await options.credential();
    checkScope(scope);
    const url = new URL(base.toString().replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const result = await options.httpClient.request({
      url: url.toString(),
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: credential, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: Buffer.from(canonical(body)) }),
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      redirect: "manual",
      trace: options.trace,
    });
    checkScope(scope);
    if (result.status === 413) throw new ConversationSyncError("limit");
    if (result.status === 401 || result.status === 403) throw new ConversationSyncError("scope");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(result.body).toString("utf8"));
    } catch (cause) {
      throw new ConversationSyncError("invalid", { cause });
    }
    if (result.status !== 200) {
      const failure = syncErrorSchema.safeParse(decoded);
      if (!failure.success) throw new ConversationSyncError("invalid");
      throw new ConversationSyncError(failure.data.error);
    }
    return decoded;
  }
  return {
    files: {
      async put(scope, file, bytes) {
        const saved = z
          .object({ saved: z.literal(true) })
          .strict()
          .safeParse(
            await request(
              scope,
              "/file",
              {},
              {
                file: conversationFileSchema.parse(file),
                dataBase64: Buffer.from(bytes).toString("base64"),
              },
            ),
          );
        if (!saved.success) throw new ConversationSyncError("invalid");
      },
      async read(scope, file) {
        const value = z
          .object({ dataBase64: z.string().max(24 * 1024 * 1024) })
          .strict()
          .safeParse(
            await request(scope, "/file-read", {}, { file: conversationFileSchema.parse(file) }),
          );
        if (!value.success) throw new ConversationSyncError("invalid");
        return Buffer.from(value.data.dataBase64, "base64");
      },
    },
    async continuation(scope, session, operation) {
      const data = await request(scope, "/continuation-operation", { session, operation });
      return data === null ? null : conversationContinuationRecordSchema.parse(data);
    },
    async history(scope, after, limit) {
      return conversationHistorySchema.parse(
        await request(scope, "/history", {
          ...(after === null ? {} : { after }),
          limit: String(limit),
        }),
      );
    },
    async execute(scope, input) {
      const parsed = syncRequestSchema.safeParse(input);
      if (!parsed.success || parsed.data.command.kind !== "receive")
        throw new ConversationSyncError("blocked");
      const data = await request(scope, "/versions", {}, parsed.data);
      // contracts use its own Zod major; schema.safeParse remains the single runtime authority.
      const receipt = syncReceiptSchema.safeParse(data);
      if (
        !receipt.success ||
        receipt.data.operation !== parsed.data.operation ||
        receipt.data.session !== parsed.data.session ||
        receipt.data.fingerprint !== digest(parsed.data.command) ||
        receipt.data.outcome !== "saved"
      )
        throw new ConversationSyncError("invalid");
      return receipt.data;
    },
    async state(scope, session) {
      const data = await request(scope, "/state", { session });
      const result = syncStateSchema.nullable().safeParse(data);
      if (!result.success) throw new ConversationSyncError("invalid");
      return result.data;
    },
    async version(scope, session, version) {
      const data = await request(scope, "/version", { session, version });
      const result = syncVersionSchema.nullable().safeParse(data);
      if (!result.success) throw new ConversationSyncError("invalid");
      if (
        result.data &&
        (result.data.id !== version ||
          (result.data.checkpoint && result.data.checkpoint.session.id !== session))
      )
        throw new ConversationSyncError("invalid");
      return result.data;
    },
    async receipt(scope, session, operation) {
      const data = await request(scope, "/receipt", { session, operation });
      const result = syncReceiptSchema.nullable().safeParse(data);
      if (!result.success) throw new ConversationSyncError("invalid");
      return result.data;
    },
    async list(scope, after, limit) {
      const data = await request(scope, "/sessions", {
        ...(after === null ? {} : { after }),
        limit: String(limit),
      });
      const result = syncListSchema.safeParse(data);
      if (!result.success) throw new ConversationSyncError("invalid");
      return result.data;
    },
  };
}
