import { z } from "zod";
import {
  nativeDeliverFilesOutputSchema,
  nativeDeliverFilesOutputJsonSchema,
  type NativeDeliverFilesOutput,
} from "@zcode/shared";
import { normalizeToolJsonSchema, toToolJsonSchema } from "./json-schema.js";

export const DELIVER_FILES_TOOL_NAME = "DeliverFiles";
export const DeliverFilesInputSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            previous: z
              .object({ id: z.string().uuid(), version: z.number().int().positive() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const DeliverFilesOutputSchema = z.custom<NativeDeliverFilesOutput>(
  (value) => nativeDeliverFilesOutputSchema.safeParse(value).success,
);
export const DeliverFilesInputJsonSchema = toToolJsonSchema(DeliverFilesInputSchema);
// CLI 输入沿 Zod 3；共享协议沿 Zod 4。输出从其 owner schema 派生，不复制字段或强转类型。
export const DeliverFilesOutputJsonSchema = normalizeToolJsonSchema(
  nativeDeliverFilesOutputJsonSchema,
);

export const deliverFilesToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("deliver_files"),
    result: DeliverFilesOutputSchema,
  })
  .strict();
