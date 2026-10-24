import { z } from "zod";
import { conversationSessionIdSchema, conversationIndexFactsSchema } from "./conversation-sync.js";
import { conversationScopeSchema } from "./conversation-sync.js";
import { conversationFileSchema } from "./conversation-files.js";

const session = conversationSessionIdSchema;
// Version and location references are opaque SQL identities, never directory segments.
const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const operation = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const base = { session, operation };
/** Host-only control. No paths, credentials or browser-provided barrier assertions. */
export const conversationRuntimeCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...base, kind: z.literal("close"), supersedeOperation: operation.optional() })
    .strict(),
  z.object({ ...base, kind: z.literal("capture") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("cancel"),
      version: reference.optional(),
      generation: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("read") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("stage"),
      branchMode: z.enum(["primary", "offline"]).optional(),
      management: conversationIndexFactsSchema,
      files: z.array(conversationFileSchema).max(1000).optional(),
      dataBase64: z
        .string()
        .min(1)
        .max(32 * 1024 * 1024),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("apply") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("activateOffline"),
      version: reference,
      generation: z.literal(0),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("activate"),
      version: reference,
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export type ConversationRuntimeCommand = z.infer<typeof conversationRuntimeCommandSchema>;
export const conversationRuntimeResultSchema = z
  .object({
    session,
    operation,
    state: z.enum(["closing", "closed", "staged", "applied", "active", "cancelled"]),
    generation: z.number().int().nonnegative(),
    version: reference.nullable(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    management: conversationIndexFactsSchema.optional(),
    files: z.array(conversationFileSchema).max(1000).optional(),
    baseVersion: reference.nullable().optional(),
    branchMode: z.enum(["primary", "offline"]).optional(),
    dataBase64: z
      .string()
      .max(32 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type ConversationRuntimeResult = z.infer<typeof conversationRuntimeResultSchema>;
export interface ConversationRuntimePort {
  content?(
    input: import("./conversation-files.js").ConversationContentRequest,
  ): Promise<import("./conversation-files.js").ConversationContentResult>;
  control(input: ConversationRuntimeCommand): Promise<ConversationRuntimeResult>;
}
export const conversationRuntimeIdentitySchema = z
  .object({ location: reference, scope: conversationScopeSchema })
  .strict();
export const conversationCaptureBaseSchema = z
  .object({ baseVersion: reference.nullable() })
  .strict();
export class ConversationRuntimeError extends Error {
  constructor(readonly code: string) {
    super("Native continuation: " + code);
  }
}
