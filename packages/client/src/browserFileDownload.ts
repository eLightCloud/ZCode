import type { FileDownloadDestination, SaveFileRequest, SaveFileResult } from "@zcode/shared";

/** Browser platform adapter shared by the Web and Desktop assemblies, never UI. */
export async function openBrowserFileDownload(
  name: string,
  saveFile?: (input: SaveFileRequest) => Promise<SaveFileResult>,
): Promise<FileDownloadDestination> {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  const handle = picker ? await picker.call(window, { suggestedName: name }) : undefined;
  const writer = handle ? await handle.createWritable() : undefined;
  const blocks: ArrayBuffer[] = [];
  let size = 0;
  return {
    maxBytes: writer ? undefined : 100 * 1024 ** 2,
    async write(bytes) {
      size += bytes.byteLength;
      if (!writer && size > 100 * 1024 ** 2) throw new Error("file_download_streaming_required");
      if (writer) await writer.write(new Uint8Array(bytes));
      else blocks.push(new Uint8Array(bytes).buffer);
    },
    async close() {
      if (writer) {
        await writer.close();
        return "completed";
      }
      const blob = new Blob(blocks, { type: "application/octet-stream" });
      if (saveFile) {
        const result = await saveFile({ suggestedName: name, data: await blob.arrayBuffer() });
        if (result.canceled) throw new DOMException("Cancelled", "AbortError");
        if (!result.success) throw new Error("file_download_unavailable");
        return "completed";
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.rel = "noreferrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return "initiated";
    },
    async abort() {
      blocks.length = 0;
      await writer?.abort();
    },
  };
}
