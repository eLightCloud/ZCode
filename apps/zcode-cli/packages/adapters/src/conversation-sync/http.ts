import type { NodeHttpIncomingRequest, NodeHttpOutgoingResponse } from "../http/index.js";
import {
  ConversationSyncError,
  syncRequestSchema,
  syncVersionSchema,
  type ConversationSyncStore,
  type Logger,
  type SyncScope,
  type SyncRequest,
} from "@zcode/contracts";
import { digest } from "./canonical.js";
import {
  conversationDeletionChoiceSchema,
  conversationContinuationIntentSchema,
  conversationContinuationCancelSchema,
  conversationFileSchema,
  type ConversationFile,
  type ConversationObservation,
  conversationObservationReasonSchema,
} from "@zcode/shared";
import { z } from "zod";
import { SyncDiagnosticError, type createConversationSyncMonitor } from "./monitoring.js";
import type { createConversationTerminalStore } from "./terminals.js";
import type { createConversationContinuation } from "./continuation.js";

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
  monitor?: ReturnType<typeof createConversationSyncMonitor>;
  terminals?: ReturnType<typeof createConversationTerminalStore>;
  continuation?: ReturnType<typeof createConversationContinuation>;
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
    let observation: ConversationObservation | undefined;
    let action: ConversationObservation["action"] | undefined;
    let failureReason: ConversationObservation["reason"] = "unavailable";
    function reply(status: number, body: unknown) {
      if (action) {
        const state = typeof body === "object" && body !== null && "status" in body ? body.status : null;
        const reason = typeof body === "object" && body !== null && "reason" in body ? body.reason : null;
        observation = status >= 400
          ? { action, outcome: status >= 500 ? "failed" : "rejected", reason: failureReason }
          : state === "waiting" || state === "forward_only" || state === "cancelling"
            ? { action, outcome: "waiting", reason: conversationObservationReasonSchema.safeParse(reason).success
                ? conversationObservationReasonSchema.parse(reason) : state === "forward_only" ? "forward_only" : state === "cancelling" ? "cancelling" : "blocked" }
            : state === "stale" ? { action, outcome: "rejected", reason: "stale" }
            : { action, outcome: "succeeded", reason: "none" };
      }
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
      if (request.method === "POST") {
        action = url.pathname === "/versions" ? "checkpoint"
          : url.pathname === "/file" ? "file_upload"
          : url.pathname === "/file-read" ? "file_read"
          : ["/continue", "/continue-cancel"].includes(url.pathname) ? "continuation" : undefined;
      } else if (request.method === "GET" && url.pathname === "/attachment") action = "file_read";
      if (request.method === "GET" && url.pathname === "/admission") {
        await options.store.state(scope, "sync-admission-probe");
        reply(200, { admitted: true });
      } else if (
        request.method === "POST" &&
        [
          "/versions",
          // 首次登记与内部 enroll 分支必须使用同一分发入口，否则保存后始终 404。
          "/enroll",
          "/deletion-choice",
          "/continue",
          "/continue-cancel",
          "/file",
          "/file-read",
          "/terminal-report",
        ].includes(url.pathname)
      ) {
        if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
          throw new ConversationSyncError("invalid");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const raw of request) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          bytes += chunk.byteLength;
          if (bytes > (url.pathname === "/terminal-report" ? Math.min(32768, options.maxRequestBytes) : options.maxRequestBytes)) throw new SyncDiagnosticError("limit", "transport_limit");
          chunks.push(chunk);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ConversationSyncError("invalid");
        }
        if (url.pathname === "/terminal-report") {
          if (!options.terminals) throw new ConversationSyncError("blocked");
          const source = request.headers["x-zcode-sync-location"], kind = request.headers["x-zcode-sync-source-kind"];
          if (typeof source !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(source) || (kind !== "desktop" && kind !== "server")) throw new ConversationSyncError("scope");
          reply(200, await options.terminals.report(scope, source, kind, body, typeof correlation === "string" ? correlation : undefined)); return;
        }
        if (url.pathname === "/file" || url.pathname === "/file-read") {
          if (!options.store.files) throw new ConversationSyncError("blocked");
          const parsed = z
            .object({
              file: z.custom<ConversationFile>(
                (value) => conversationFileSchema.safeParse(value).success,
              ),
              ...(url.pathname === "/file" ? { dataBase64: z.string().max(24 * 1024 * 1024) } : {}),
            })
            .strict()
            .safeParse(body);
          if (!parsed.success) throw new ConversationSyncError("invalid");
          if (url.pathname === "/file") {
            await options.store.files.put(
              scope,
              parsed.data.file,
              Buffer.from((parsed.data as { dataBase64: string }).dataBase64, "base64"),
            );
            reply(200, { saved: true });
          } else
            reply(200, {
              dataBase64: Buffer.from(
                await options.store.files.read(scope, parsed.data.file),
              ).toString("base64"),
            });
          return;
        }
        if (url.pathname === "/enroll") {
          if (!options.continuation) throw new ConversationSyncError("blocked");
          const parsed = z
            .object({ session: z.string().min(1), version: z.string().min(1) })
            .strict()
            .safeParse(body);
          const location = syncVersionSchema
            .innerType()
            .shape.location.safeParse(request.headers["x-zcode-sync-location"]);
          if (!parsed.success || !location.success) throw new ConversationSyncError("invalid");
          reply(
            200,
            await options.continuation.enroll(
              scope,
              location.data,
              parsed.data.session,
              parsed.data.version,
            ),
          );
          return;
        }
        if (url.pathname === "/continue" || url.pathname === "/continue-cancel") {
          if (!options.continuation) throw new ConversationSyncError("blocked");
          const parsed = (
            url.pathname === "/continue"
              ? conversationContinuationIntentSchema
              : conversationContinuationCancelSchema
          ).safeParse(body);
          if (!parsed.success) throw new ConversationSyncError("invalid");
          reply(
            200,
            url.pathname === "/continue"
              ? await options.continuation.run(scope, parsed.data)
              : await options.continuation.cancel(
                  scope,
                  parsed.data.session,
                  parsed.data.operation,
                ),
          );
          return;
        }
        if (url.pathname === "/deletion-choice") {
          const choice = conversationDeletionChoiceSchema.safeParse(body);
          if (!choice.success) throw new ConversationSyncError("invalid");
          const { session, operation, version, candidates, revision } = choice.data;
          // Browser input cannot supply barriers, execution locations or recovery evidence.
          const receipt = await options.store.execute(scope, {
            session,
            operation,
            command: {
              kind: "select",
              version,
              candidates,
              revision,
              location: null,
              recoveryVerified: false,
            },
          });
          logger.info("Conversation deletion selected", {
            outcome: "selected_deleted",
            sessionId: session,
            operationId: operation,
          });
          reply(200, {
            operation,
            session,
            version,
            revision: receipt.state.revision,
            outcome: "deleted",
          });
          return;
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
        for (const file of parsed.data.command.version.files ?? []) {
          if (!options.store.files) throw new ConversationSyncError("blocked");
          await options.store.files.read(scope, file);
        }
        const receipt = await options.store.execute(scope, parsed.data);
        logger.info("Conversation version saved", {
          outcome: "server_saved",
          operationId: receipt.operation,
          sessionId: receipt.session,
        });
        reply(200, receipt);
      } else if (request.method === "GET" && url.pathname === "/continuation-options") {
        if (!options.continuation) throw new ConversationSyncError("blocked");
        reply(
          200,
          await options.continuation.options(scope, url.searchParams.get("session") ?? ""),
        );
      } else if (request.method === "GET" && url.pathname === "/effects") {
        reply(
          200,
          (await options.store.effects?.(scope, url.searchParams.get("session") ?? "")) ?? [],
        );
      } else if (request.method === "GET" && url.pathname === "/attachment") {
        const item = await options.store.version(
          scope,
          url.searchParams.get("session") ?? "",
          url.searchParams.get("version") ?? "",
        );
        const file = item?.files?.find((file) => file.uri === url.searchParams.get("uri"));
        if (!file || !options.store.files) throw new ConversationSyncError("not_found");
        reply(200, {
          file,
          dataBase64: Buffer.from(await options.store.files.read(scope, file)).toString("base64"),
        });
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
                files: item.files ?? [],
                effects: (await options.store.effects?.(scope, session)) ?? [],
                messages:
                  checkpoint?.messages
                    .filter(
                      (message) =>
                        message.info.semantics?.transcriptVisibility !== "hidden" &&
                        !(message.info.role === "user" && message.info.visibility === "model-only"),
                    )
                    .map((message) => ({
                      id: message.info.id,
                      role: message.info.role,
                      text: message.parts
                        .flatMap((part) =>
                          part.type === "text"
                            ? part.ignored || part.metadata?.visibility === "model-only"
                              ? []
                              : [part.text]
                            : part.type === "tool"
                              ? [
                                  part.state.status === "completed"
                                    ? part.state.output
                                    : part.state.error,
                                ]
                              : [],
                        )
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
      } else if (request.method === "GET" && url.pathname === "/continuation-operation") {
        if (!options.store.continuation) throw new ConversationSyncError("blocked");
        reply(
          200,
          await options.store.continuation(
            scope,
            url.searchParams.get("session") ?? "",
            url.searchParams.get("operation") ?? "",
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
      const parsedReason = conversationObservationReasonSchema.safeParse(code);
      failureReason = cause instanceof SyncDiagnosticError ? cause.reason
        : parsedReason.success ? parsedReason.data : "blocked";
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
      if (!response.headersSent) reply(status, { error: code, ...(request.headers["x-zcode-sync-diagnostics"] === "1" ? { reason: failureReason } : {}) });
      else response.destroy();
    } finally {
      if (observation && options.monitor) await options.monitor.record(observation, typeof correlation === "string" ? correlation : undefined);
    }
  };
}
