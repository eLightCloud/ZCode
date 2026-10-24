import { z } from "zod";
export const conversationArtifactUriSchema = z
  .string()
  .regex(
    /^zcode-artifact:\/\/([A-Za-z0-9_-]{1,128})\/tool-result-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
export const conversationFileSchema = z
  .object({
    uri: conversationArtifactUriSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    contentType: z.string().min(1).max(256),
  })
  .strict();
export type ConversationFile = z.infer<typeof conversationFileSchema>;
export const conversationContentRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("read"),
      session: z.string().min(1).max(128),
      uri: conversationArtifactUriSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore"),
      session: z.string().min(1).max(128),
      operation: z.string().uuid(),
      file: conversationFileSchema,
      dataBase64: z.string().max(24 * 1024 * 1024),
    })
    .strict(),
]);
export const conversationContentResultSchema = z
  .object({
    file: conversationFileSchema,
    dataBase64: z
      .string()
      .max(24 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type ConversationContentRequest = z.infer<typeof conversationContentRequestSchema>;
export type ConversationContentResult = z.infer<typeof conversationContentResultSchema>;
