import { useCallback } from "react";
import {
  conversationContentResultSchema,
  type ConversationFile,
  type ConversationHistoryReader,
  type IPlatformService,
} from "@zcode/shared";
import { useOptionalPlatform } from "./usePlatform.js";
import { logger } from "../logger.js";

/** Reads one authenticated fixed version; the platform remains the download destination owner. */
export function useConversationFileDownload(
  reader: ConversationHistoryReader,
  fallback?: IPlatformService["openFileDownload"],
) {
  const platform = useOptionalPlatform();
  const destination = platform?.openFileDownload?.bind(platform) ?? fallback;
  return useCallback(
    async (session: string, version: string, file: ConversationFile, signal: AbortSignal) => {
      if (!reader.file || !destination) throw new Error("conversation_download_unavailable");
      const output = await destination("attachment");
      try {
        const value = conversationContentResultSchema.parse(
          await reader.file(session, version, file.uri, signal),
        );
        signal.throwIfAborted();
        if (
          value.dataBase64 === undefined ||
          value.file.uri !== file.uri ||
          value.file.sha256 !== file.sha256 ||
          value.file.bytes !== file.bytes
        )
          throw new Error("conversation_download_changed");
        const bytes = Uint8Array.from(atob(value.dataBase64), (char) => char.charCodeAt(0));
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        if (
          bytes.length !== file.bytes ||
          Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") !== file.sha256
        )
          throw new Error("conversation_download_changed");
        // 原生 artifact 的图片/文件可能是 data URL 封装。先校验固定封装，再解出原始文件。
        const dataUrl = new TextDecoder()
          .decode(bytes)
          .match(/^data:[^;,\s]+;base64,([A-Za-z0-9+/=\r\n]+)$/);
        const content = dataUrl
          ? Uint8Array.from(atob(dataUrl[1]!.replace(/[\r\n]/g, "")), (char) => char.charCodeAt(0))
          : bytes;
        signal.throwIfAborted();
        if (output.maxBytes !== undefined && content.length > output.maxBytes)
          throw new Error("file_download_streaming_required");
        await output.write(content);
        signal.throwIfAborted();
        const outcome = await output.close();
        logger.info("conversation.file.download", { sessionId: session, outcome });
      } catch (error) {
        await output.abort().catch(() => undefined);
        logger.warn("conversation.file.download", {
          sessionId: session,
          outcome: signal.aborted ? "cancelled" : "failed",
        });
        throw error;
      }
    },
    [reader, destination],
  );
}
