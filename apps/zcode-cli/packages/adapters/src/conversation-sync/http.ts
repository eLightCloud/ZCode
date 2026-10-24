import type { NodeHttpIncomingRequest, NodeHttpOutgoingResponse } from "../http/index.js";
import {
  ConversationSyncError,
  syncRequestSchema,
  type ConversationSyncStore,
  type Logger,
  type SyncScope,
  type SyncRequest,
} from "@zcode/contracts";
import { digest } from "./canonical.js";

/** Trusted assembly supplies identity/qualification; browsers cannot supply barrier proofs. */
export function createConversationSyncHttpHandler(options: {
  store: ConversationSyncStore;
  maxRequestBytes: number;
  authenticate(request: NodeHttpIncomingRequest): Promise<SyncScope | null>;
  qualify(
    scope: SyncScope,
    request: SyncRequest,
    transport: NodeHttpIncomingRequest,
  ): Promise<boolean>;
  logger: Logger;
}) {
  if (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1)
    throw new ConversationSyncError("invalid");
  return async (
    request: NodeHttpIncomingRequest,
    response: NodeHttpOutgoingResponse,
  ): Promise<void> => {
    const correlation = request.headers["x-correlation-id"];
    const logger = options.logger.child({
      event: "conversation.sync.http",
      ...(typeof correlation === "string" && /^[a-f0-9]{32}$/.test(correlation)
        ? { correlationId: correlation }
        : {}),
    });
    function reply(status: number, body: unknown) {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(body));
    }
    try {
      const scope = await options.authenticate(request);
      if (!scope) {
        reply(401, { error: "authentication_required" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://native.invalid");
      if (request.method === "GET" && url.pathname === "/admission") {
        await options.store.state(scope, "sync-admission-probe");
        reply(200, { admitted: true });
      } else if (request.method === "POST" && url.pathname === "/versions") {
        if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
          throw new ConversationSyncError("invalid");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const raw of request) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          bytes += chunk.byteLength;
          if (bytes > options.maxRequestBytes) throw new ConversationSyncError("limit");
          chunks.push(chunk);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ConversationSyncError("invalid");
        }
        const parsed = syncRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.command.kind !== "receive")
          throw new ConversationSyncError("invalid");
        if (!(await options.qualify(scope, parsed.data, request))) {
          // 资格改变不能抹掉已提交的准确回执；这里只确认旧操作，不接纳任何新版本。
          const saved = await options.store.receipt(
            scope,
            parsed.data.session,
            parsed.data.operation,
          );
          if (!saved) throw new ConversationSyncError("scope");
          if (saved.fingerprint !== digest(parsed.data.command))
            throw new ConversationSyncError("conflict");
          logger.info("Existing conversation receipt confirmed", {
            outcome: "server_saved",
            operationId: saved.operation,
            sessionId: saved.session,
          });
          reply(200, saved);
          return;
        }
        const receipt = await options.store.execute(scope, parsed.data);
        logger.info("Conversation version saved", {
          outcome: "server_saved",
          operationId: receipt.operation,
          sessionId: receipt.session,
        });
        reply(200, receipt);
      } else if (request.method === "GET" && url.pathname === "/transcript") {
        const session = url.searchParams.get("session") ?? "";
        const version = url.searchParams.get("version") ?? "";
        const item = await options.store.version(scope, session, version);
        const checkpoint = item?.checkpoint;
        reply(
          200,
          item
            ? {
                session,
                version,
                deleted: checkpoint === null,
                title: item.management?.titleOverride ?? checkpoint?.session.title ?? "",
                messages:
                  checkpoint?.messages.map((message) => ({
                    id: message.info.id,
                    role: message.info.role,
                    text: message.parts
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
                  })) ?? [],
              }
            : null,
        );
      } else if (request.method === "GET" && url.pathname === "/history") {
        reply(
          200,
          await options.store.history(
            scope,
            url.searchParams.get("after"),
            Number(url.searchParams.get("limit") ?? "50"),
          ),
        );
      } else if (request.method === "GET" && url.pathname === "/sessions") {
        reply(
          200,
          await options.store.list(
            scope,
            url.searchParams.get("after"),
            Number(url.searchParams.get("limit") ?? "50"),
          ),
        );
      } else if (request.method === "GET" && url.pathname === "/state") {
        reply(200, await options.store.state(scope, url.searchParams.get("session") ?? ""));
      } else if (request.method === "GET" && url.pathname === "/version") {
        reply(
          200,
          await options.store.version(
            scope,
            url.searchParams.get("session") ?? "",
            url.searchParams.get("version") ?? "",
          ),
        );
      } else if (request.method === "GET" && url.pathname === "/receipt") {
        const operation = url.searchParams.get("operation") ?? "";
        if (!/^[a-f0-9-]{36}$/i.test(operation)) throw new ConversationSyncError("invalid");
        reply(
          200,
          await options.store.receipt(scope, url.searchParams.get("session") ?? "", operation),
        );
      } else reply(404, { error: "not_found" });
    } catch (cause) {
      const code = cause instanceof ConversationSyncError ? cause.code : "storage";
      const status =
        code === "scope"
          ? 403
          : code === "limit"
            ? 413
            : code === "storage"
              ? 503
              : code === "invalid"
                ? 400
                : 409;
      logger.warn("Conversation sync HTTP rejected", {
        event: "conversation.sync.http",
        status: "failed",
        outcome: "rejected",
        code,
      });
      if (!response.headersSent) reply(status, { error: code });
      else response.destroy();
    }
  };
}
