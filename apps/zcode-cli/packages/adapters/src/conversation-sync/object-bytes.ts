import { z } from "zod";
import { ConversationSyncError, type ConversationObjectBytesPort } from "@zcode/contracts";
import { createNativeResourceClient } from "./private-resource-client.js";
const receipt = z
  .object({
    binding: z.string().uuid(),
    version: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value !== "null"),
  })
  .strict();

/** Resource credentials never leave the enterprise Credential/byte adapter boundary. */
export function createConversationObjectBytes(
  options: Parameters<typeof createNativeResourceClient>[0],
): ConversationObjectBytesPort {
  const request = createNativeResourceClient(options);
  return {
    async put(scope, file, bytes) {
      const result = z
        .object({ receipt })
        .strict()
        .safeParse(
          await request("/api/native/conversation-bytes", {
            ...scope,
            sha256: file.sha256,
            bytes: file.bytes,
            dataBase64: Buffer.from(bytes).toString("base64"),
          }),
        );
      if (!result.success) throw new ConversationSyncError("storage");
      return result.data.receipt;
    },
    async read(scope, file, binding) {
      const result = z
        .object({ receipt, dataBase64: z.string().max(24 * 1024 * 1024) })
        .strict()
        .safeParse(
          await request("/api/native/conversation-bytes", {
            ...scope,
            sha256: file.sha256,
            bytes: file.bytes,
            receipt: receipt.parse(binding),
          }),
        );
      if (
        !result.success ||
        result.data.receipt.binding !== binding.binding ||
        result.data.receipt.version !== binding.version
      )
        throw new ConversationSyncError("storage");
      return Buffer.from(result.data.dataBase64, "base64");
    },
  };
}
