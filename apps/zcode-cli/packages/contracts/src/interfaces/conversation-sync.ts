import { z } from "zod";
import { textCheckpointSchema } from "./text-checkpoint.js";

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const syncScopeSchema = z.object({ tenant: uuid, subject: uuid }).strict();
export type SyncScope = z.infer<typeof syncScopeSchema>;
const expected = { revision };
const binding = z.object({ location: key, generation: revision, version: key }).strict();
export const syncVersionSchema = z
  .object({
    id: key,
    parent: key.nullable(),
    location: key,
    generation: revision,
    checkpoint: textCheckpointSchema.nullable(),
  })
  .strict();
export type SyncVersion = z.infer<typeof syncVersionSchema>;
export const syncCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receive"), version: syncVersionSchema }).strict(),
  z
    .object({
      kind: z.literal("promote"),
      ...expected,
      version: key,
      otherOwnersSettled: z.literal(true),
      location: key,
    })
    .strict(),
  z
    .object({
      kind: z.literal("select"),
      ...expected,
      candidates: z.array(key),
      version: key,
      location: key.nullable(),
      recoveryVerified: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("begin"),
      ...expected,
      handoff: key,
      source: key,
      generation: revision,
      target: key,
      baseline: key,
    })
    .strict(),
  z
    .object({
      kind: z.literal("grant"),
      ...expected,
      handoff: key,
      checkpoint: key,
      sourceBarrier: z.literal(true),
      dependenciesVerified: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal("cancel"), handoff: key }).strict(),
  z
    .object({
      kind: z.literal("fence"),
      ...expected,
      location: key,
      generation: revision,
      sourceBarrier: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("activate"),
      ...expected,
      location: key,
      generation: revision,
      version: key,
      recoveryVerified: z.literal(true),
    })
    .strict(),
]);
export type SyncCommand = z.infer<typeof syncCommandSchema>;
export const syncRequestSchema = z
  .object({
    session: key,
    operation: uuid,
    command: syncCommandSchema,
  })
  .strict();
export type SyncRequest = z.infer<typeof syncRequestSchema>;
const handoff = z
  .object({
    id: key,
    source: key,
    target: key,
    generation: revision,
    baseline: key,
    checkpoint: key.nullable(),
    selection: revision,
    phase: z.enum(["requested", "granted", "activated", "cancelled"]),
  })
  .strict();
export const syncStateSchema = z
  .object({
    revision,
    selection: revision,
    generation: revision,
    selected: key.nullable(),
    candidates: z.array(key),
    resolved: z.array(key),
    active: binding.nullable(),
    pending: binding.nullable(),
    handoff: handoff.nullable(),
  })
  .strict();
export type SyncState = z.infer<typeof syncStateSchema>;
export const syncListSchema = z.array(z.object({ session: key, state: syncStateSchema }).strict());
export const syncReceiptSchema = z
  .object({
    operation: uuid,
    session: key,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum([
      "saved",
      "promoted",
      "selected",
      "requested",
      "granted",
      "cancelled",
      "activated",
      "fenced",
    ]),
    state: syncStateSchema,
  })
  .strict();
export type SyncReceipt = z.infer<typeof syncReceiptSchema>;
export const syncErrorSchema = z
  .object({
    error: z.enum([
      "invalid",
      "stale",
      "conflict",
      "not_found",
      "blocked",
      "forward_only",
      "limit",
      "scope",
      "schema",
      "storage",
    ]),
  })
  .strict();
export class ConversationSyncError extends Error {
  constructor(
    readonly code: z.infer<typeof syncErrorSchema>["error"],
    options?: ErrorOptions,
  ) {
    super(`Conversation sync: ${code}`, options);
    this.name = "ConversationSyncError";
  }
}
export interface ConversationSyncStore {
  /** Trusted native assembly only; browser payloads must not supply scope/proofs. */
  execute(scope: SyncScope, request: SyncRequest): Promise<SyncReceipt>;
  state(scope: SyncScope, session: string): Promise<SyncState | null>;
  version(scope: SyncScope, session: string, version: string): Promise<SyncVersion | null>;
  receipt(scope: SyncScope, session: string, operation: string): Promise<SyncReceipt | null>;
  list(
    scope: SyncScope,
    after: string | null,
    limit: number,
  ): Promise<Array<{ session: string; state: SyncState }>>;
}
