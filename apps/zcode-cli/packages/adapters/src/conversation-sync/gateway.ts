import { syncScopeSchema, type ConversationSyncStore, type Logger } from "@zcode/contracts";
import type { NodeHttpIncomingRequest } from "../http/index.js";
import { createConversationSyncHttpHandler } from "./http.js";
import type { createConversationSyncMonitor } from "./monitoring.js";
import type { createConversationTerminalStore } from "./terminals.js";
import { privateProofMatcher } from "./private-proof.js";
import { createConfigurationHandler } from "./configuration-http.js";
import type { createConversationSyncPolicyStore } from "./policy.js";
import { createConversationContinuation } from "./continuation.js";
import type { ConversationRuntimeDirectory } from "./continuation-runtime-steps.js";

/** Only the authenticated private ingress may construct scope; never expose this socket publicly. */
export function createConversationSyncGateway(options: {
  store: ConversationSyncStore;
  proof: string;
  maxRequestBytes: number;
  logger: Logger;
  monitor?: ReturnType<typeof createConversationSyncMonitor>;
  terminals?: ReturnType<typeof createConversationTerminalStore>;
  runtimes?: ConversationRuntimeDirectory;
  configuration?: { proof: string; store: ReturnType<typeof createConversationSyncPolicyStore> };
}) {
  const authentic = privateProofMatcher(options.proof);
  if (options.configuration?.proof === options.proof)
    throw new Error("Distinct channel proofs required");
  const configuration = options.configuration
    ? createConfigurationHandler({ ...options.configuration, logger: options.logger, monitor: options.monitor })
    : null;
  const data = createConversationSyncHttpHandler({
    ...options,
    continuation: options.runtimes
      ? createConversationContinuation({
          store: options.store,
          runtimes: options.runtimes,
          logger: options.logger,
        })
      : undefined,
    authenticate: async (request: NodeHttpIncomingRequest) => {
      if (!authentic(request)) return null;
      const parsed = syncScopeSchema.safeParse({
        tenant: request.headers["x-zcode-sync-tenant"],
        subject: request.headers["x-zcode-sync-subject"],
      });
      return parsed.success ? parsed.data : null;
    },
    // A public browser cannot obtain this source capability. Native Host capture still
    // rechecks qualification inside its barrier; the ingress never trusts a JSON flag.
    qualify: async (_scope, request, transport) =>
      request.command.kind === "receive" &&
      request.command.version.location === transport.headers["x-zcode-sync-location"] &&
      request.command.version.management !== undefined &&
      request.command.version.management.pinned !== undefined &&
      request.command.version.management.deleted === (request.command.version.checkpoint === null),
  });
  return async (
    request: NodeHttpIncomingRequest,
    response: import("../http/index.js").NodeHttpOutgoingResponse,
  ) => {
    if (["/configuration", "/monitoring", "/usage"].includes((request.url ?? "/").split("?")[0])) {
      if (configuration) await configuration(request, response);
      else {
        response.writeHead(503);
        response.end();
      }
    } else await data(request, response);
  };
}
