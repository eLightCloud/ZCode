import { conversationCenterConfigurationSchema } from "@zcode/shared";
import { ConversationSyncError, type Logger } from "@zcode/contracts";
import type { NodeHttpIncomingRequest, NodeHttpOutgoingResponse } from "../http/index.js";
import type { createConversationSyncPolicyStore } from "./policy.js";
import { privateProofMatcher } from "./private-proof.js";

export function createConfigurationHandler(options: {
  proof: string;
  store: ReturnType<typeof createConversationSyncPolicyStore>;
  logger: Logger;
}) {
  const authentic = privateProofMatcher(options.proof);
  return async (request: NodeHttpIncomingRequest, response: NodeHttpOutgoingResponse) => {
    const correlation = request.headers["x-correlation-id"];
    const logger = options.logger.child({
      event: "conversation.sync.configuration.http",
      ...(typeof correlation === "string" && /^[a-f0-9]{32}$/.test(correlation)
        ? { correlationId: correlation }
        : {}),
    });
    function reply(status: number, body: unknown) {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    }
    if (!authentic(request)) {
      reply(401, { error: "authentication_required" });
      return;
    }
    try {
      if (request.method === "GET") reply(200, await options.store.read());
      else if (request.method === "PUT") {
        if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
          throw new ConversationSyncError("invalid");
        const chunks = [];
        let size = 0;
        for await (const raw of request) {
          const chunk = Buffer.from(raw);
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) throw new ConversationSyncError("limit");
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ConversationSyncError("invalid");
        }
        const parsed = conversationCenterConfigurationSchema.safeParse(input);
        if (!parsed.success) throw new ConversationSyncError("invalid");
        const saved = await options.store.update(parsed.data.revision, parsed.data.policy);
        logger.info("Conversation policy saved", { revision: saved.revision, outcome: "updated" });
        reply(200, saved);
      } else reply(404, { error: "not_found" });
    } catch (cause) {
      const code = cause instanceof ConversationSyncError ? cause.code : "storage";
      logger.warn("Conversation configuration rejected", {
        event: "conversation.sync.configuration",
        outcome: "rejected",
        code,
      });
      reply(
        code === "stale"
          ? 409
          : code === "scope"
            ? 403
            : code === "limit"
              ? 413
              : code === "invalid"
                ? 400
                : 503,
        { error: code },
      );
    }
  };
}
