import { z } from "zod";

/** 原生交付描述符的唯一 schema；存储定位和消费应用策略不进入协议。 */
export const nativeDeliverableSchema = z
  .object({
    kind: z.literal("file"),
    purpose: z.literal("final"),
    id: z.string().uuid(),
    version: z.number().int().positive(),
    sequence: z.number().int().positive(),
    workspaceKey: z.string().min(1).max(4096),
    sessionId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256).optional(),
    requestKey: z.string().min(1).max(512),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    producerContextRef: z.string().min(1).max(256).optional(),
    previous: z
      .object({ id: z.string().uuid(), version: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

export type NativeDeliverable = z.infer<typeof nativeDeliverableSchema>;

export const nativeDeliverFilesOutputSchema = z
  .object({
    files: z
      .array(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("delivered"), file: nativeDeliverableSchema }).strict(),
          z
            .object({ status: z.literal("failed"), index: z.number().int(), code: z.string() })
            .strict(),
        ]),
      )
      .max(100),
  })
  .strict();
export const nativeDeliverFilesOutputJsonSchema = z.toJSONSchema(nativeDeliverFilesOutputSchema);

export const nativeDeliverablesListInputSchema = z
  .object({
    workspaceKey: z.string().min(1).max(4096),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export const nativeDeliverablesListSchema = z
  .object({
    entries: z.array(nativeDeliverableSchema),
    cursor: z.number().int().nonnegative(),
  })
  .strict();

export const nativeDeliverableReadSchema = z
  .object({
    workspaceKey: z.string().min(1).max(4096),
    id: z.string().uuid(),
    version: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    length: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
  })
  .strict();

export const nativeDeliverableReleaseSchema = nativeDeliverableReadSchema
  .omit({ offset: true, length: true })
  .extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export type NativeDeliverFilesOutput = z.infer<typeof nativeDeliverFilesOutputSchema>;
export const nativeDeliverFilesDisplaySchema = z
  .object({
    kind: z.literal("deliver_files"),
    result: nativeDeliverFilesOutputSchema,
  })
  .strict();
export type NativeDeliverFilesDisplay = z.infer<typeof nativeDeliverFilesDisplaySchema>;
