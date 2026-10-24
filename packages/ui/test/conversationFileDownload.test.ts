// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationHistoryReader } from "@zcode/shared";
import { useConversationFileDownload } from "../src/hooks/useConversationFileDownload.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
function setup(damaged = false) {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = Buffer.from(
    "data:image/png;base64," + Buffer.from("SYNTHETIC_PNG_BYTES").toString("base64"),
  );
  const file = {
    uri: "zcode-artifact://session/tool-result-00000000-0000-4000-8000-000000000001",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/plain",
  };
  const reader: ConversationHistoryReader = {
    history: async () => [],
    transcript: async () => null,
    file: vi.fn(async () => ({
      file,
      dataBase64: (damaged ? Buffer.from("corrupt") : bytes).toString("base64"),
    })),
  };
  const output = {
    write: vi.fn(async (_bytes: Uint8Array) => {}),
    close: vi.fn(async () => "completed" as const),
    abort: vi.fn(async () => {}),
  };
  const open = vi.fn(async () => output);
  const hook = renderHook(() => useConversationFileDownload(reader, open));
  return { file, reader, output, open, download: hook.result.current };
}
it("verifies the fixed artifact before decoding the original attachment and saving through the platform", async () => {
  const { download, file, reader, output } = setup();
  const signal = new AbortController().signal;
  await download("session", "exact-version", file, signal);
  expect(reader.file).toHaveBeenCalledWith("session", "exact-version", file.uri, signal);
  expect(Buffer.from(output.write.mock.calls[0]![0]).toString()).toBe("SYNTHETIC_PNG_BYTES");
  expect(output.close).toHaveBeenCalledOnce();
  expect(output.abort).not.toHaveBeenCalled();
});
it("does not publish corrupted or late bytes after an identity/view change", async () => {
  const damaged = setup(true);
  await expect(
    damaged.download("session", "v", damaged.file, new AbortController().signal),
  ).rejects.toThrow("conversation_download_changed");
  expect(damaged.output.write).not.toHaveBeenCalled();
  expect(damaged.output.abort).toHaveBeenCalledOnce();
  const late = setup();
  const abort = new AbortController();
  abort.abort();
  await expect(late.download("session", "v", late.file, abort.signal)).rejects.toThrow();
  expect(late.output.write).not.toHaveBeenCalled();
  expect(late.output.close).not.toHaveBeenCalled();
});
