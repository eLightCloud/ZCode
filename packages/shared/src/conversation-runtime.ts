import {conversationEffectSchema} from "./conversation-sync.js";
import { z } from "zod";
import { conversationSessionIdSchema, conversationIndexFactsSchema } from "./conversation-sync.js";
import { conversationScopeSchema } from "./conversation-sync.js";
import { conversationFileSchema } from "./conversation-files.js";
import { modelSelectionSchema } from "./model-selection.js";

/** Safe current choices, projected by the target's native model facade. */
export const conversationModelOptionSchema = z
  .object({
    label: z.string().min(1).max(256),
    selection: modelSelectionSchema,
  })
  .strict();
export type ConversationModelOption = z.infer<typeof conversationModelOptionSchema>;

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
  z.object({...base,kind:z.literal("effects"),generation:z.number().int().nonnegative(),revision:z.number().int().nonnegative(),effects:z.array(conversationEffectSchema).max(1000)}).strict(),
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
  models?(): Promise<ConversationModelOption[]>;
  content?(
    input: import("./conversation-files.js").ConversationContentRequest,
  ): Promise<import("./conversation-files.js").ConversationContentResult>;
  control(input: ConversationRuntimeCommand): Promise<ConversationRuntimeResult>;
}
export const conversationRuntimeIdentitySchema = z
  .object({
    location: reference,
    scope: conversationScopeSchema,
    models: z.array(conversationModelOptionSchema).max(500).optional(),
  })
  .strict();
export const conversationCaptureBaseSchema = z
  .object({ baseVersion: reference.nullable() })
  .strict();
export class ConversationRuntimeError extends Error {
  constructor(readonly code: string) {
    super("Native continuation: " + code);
  }
}

/** The JSON-RPC envelope code is numeric; native domain codes live in data.code. */
export function conversationRuntimeErrorCode(error: unknown): string {
  const nested =
    error &&
    typeof error === "object" &&
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "code" in error.data
      ? error.data.code
      : undefined;
  const direct = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof nested === "string" ? nested : direct;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unavailable";
}
