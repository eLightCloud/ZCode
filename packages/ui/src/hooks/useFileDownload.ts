import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeDeliverable } from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import { usePlatform } from "./usePlatform.js";
import type { IPlatformService } from "@zcode/shared";
import { useServices } from "./useServices.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface DownloadSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  verify?(): Promise<void>;
}

async function transfer(
  platform: IPlatformService,
  name: string,
  open: () => Promise<DownloadSource>,
  signal: AbortSignal,
) {
  if (!platform.openFileDownload) throw new Error("file_download_unavailable");
  // 目标与传输由平台 owner 提供，UI 不再探测浏览器或 Electron 能力。
  const destination = await platform.openFileDownload(name);
  try {
    const source = await open();
    if (!Number.isSafeInteger(source.size) || source.size < 0)
      throw new Error("file_download_unavailable");
    if (destination.maxBytes !== undefined && source.size > destination.maxBytes)
      throw new Error("file_download_streaming_required");
    for (let offset = 0; offset < source.size; ) {
      signal.throwIfAborted();
      const length = Math.min(256 * 1024, source.size - offset);
      const chunk = await source.read(offset, length);
      if (chunk.byteLength !== length) throw new Error("file_download_source_changed");
      await destination.write(chunk);
      offset += chunk.byteLength;
    }
    signal.throwIfAborted();
    await source.verify?.();
    return await destination.close();
  } catch (error) {
    await destination.abort().catch(() => undefined);
    throw error;
  }
}

/** Both current workspace files and immutable delivery snapshots use bounded public reads. */
export function useFileDownload() {
  const services = useServices();
  const platform = usePlatform();
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const run = useCallback(
    async (name: string, open: () => Promise<DownloadSource>) => {
      if (active.current) return;
      const abort = new AbortController();
      active.current = abort;
      setBusy(true);
      try {
        const outcome = await transfer(platform, name, open, abort.signal);
        logger.info("file.download", { outcome });
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        logger.warn("file.download", { outcome: "failed" });
        throw error;
      } finally {
        active.current = undefined;
        setBusy(false);
      }
    },
    [platform],
  );
  const downloadFile = useCallback(
    (path: string) =>
      run(getPathLeaf(path), async () => {
        const before = await services.fileService.stat({ path });
        if (before.type !== "file" || before.size === undefined)
          throw new Error("file_download_unavailable");
        return {
          size: before.size,
          read: (offset, length) => services.fileService.readFileRange({ path, offset, length }),
          verify: async () => {
            const after = await services.fileService.stat({ path });
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
              throw new Error("file_download_source_changed");
          },
        };
      }),
    [run, services.fileService],
  );
  const downloadDeliverable = useCallback(
    (target: ZCodeAgentWorkspaceTarget, file: NativeDeliverable) =>
      run(file.name, async () => ({
        size: file.size,
        read: async (offset, length) => {
          const result = await services.zcodeAgentService.readDeliverable({
            ...target,
            id: file.id,
            version: file.version,
            offset,
            length,
          });
          return Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
        },
      })),
    [run, services.zcodeAgentService],
  );
  return { busy, downloadFile, downloadDeliverable };
}
