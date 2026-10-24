import { z } from "zod";
import { conversationIndexFactsSchema } from "./conversation-sync.js";
import {conversationScopeSchema} from './conversation-sync.js';

const session = z
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
  z.object({ ...base, kind: z.literal("close") }).strict(),
  z.object({ ...base, kind: z.literal("capture") }).strict(),
  z.object({ ...base, kind: z.literal("cancel") }).strict(),
  z.object({ ...base, kind: z.literal("read") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("stage"),
      management: conversationIndexFactsSchema,
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
      kind: z.literal("activate"),
      version: session,
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
    version: session.nullable(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    management: conversationIndexFactsSchema.optional(),
    dataBase64: z
      .string()
      .max(32 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type ConversationRuntimeResult = z.infer<typeof conversationRuntimeResultSchema>;
export interface ConversationRuntimePort {
  control(input: ConversationRuntimeCommand): Promise<ConversationRuntimeResult>;
}
export const conversationRuntimeIdentitySchema=z.object({location:session,scope:conversationScopeSchema}).strict();
export class ConversationRuntimeError extends Error {
  constructor(readonly code: string) {
    super("Native continuation: " + code);
  }
}
