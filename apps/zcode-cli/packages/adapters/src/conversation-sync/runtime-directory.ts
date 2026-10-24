import { z } from "zod";
import { type HttpClientPort, type SyncScope } from "@zcode/contracts";
import {
  ConversationRuntimeError,
  conversationRuntimeCommandSchema,
  conversationRuntimeResultSchema,
  conversationContentRequestSchema,
  conversationContentResultSchema,
  conversationModelOptionSchema,
} from "@zcode/shared";
import type { ConversationRuntimeDirectory } from "./continuation-runtime-steps.js";
import { createNativeResourceClient } from "./private-resource-client.js";

/** Private instance transport. URLs and credentials come only from trusted assembly. */
export function createConversationRuntimeDirectory(options: {
  url: string;
  proof: string;
  httpClient: HttpClientPort;
  trustedHttpOrigin?: string;
}): ConversationRuntimeDirectory {
  const resource = createNativeResourceClient(options);
  const call = (scope: SyncScope, location?: string, command?: unknown, content = false) =>
    resource("/api/native/conversation-runtime", {
      ...scope,
      ...(location ? { location, command, content } : {}),
    });
  return {
    async list(scope) {
      return z
        .array(
          z
            .object({
              location: z.string().min(1).max(128),
              label: z.string().max(256),
              instanceId: z.string().min(1).max(128).optional(),
              models: z.array(conversationModelOptionSchema).max(500).optional(),
            })
            .strict(),
        )
        .max(100)
        .parse(await call(scope));
    },
    async runtime(scope, location) {
      if (
        !(await this.list(scope)).some(
          (value) => value.location === location || value.instanceId === location,
        )
      )
        throw new ConversationRuntimeError("unavailable");
      return {
        content: async (input) =>
          conversationContentResultSchema.parse(
            await call(scope, location, conversationContentRequestSchema.parse(input), true),
          ),
        control: async (input) =>
          conversationRuntimeResultSchema.parse(
            await call(scope, location, conversationRuntimeCommandSchema.parse(input)),
          ),
      };
    },
  };
}
