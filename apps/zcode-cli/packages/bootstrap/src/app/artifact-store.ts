import { join } from "node:path";
import { createNodeToolArtifactStore } from "@zcode/adapters/storage";
/** Same native layout for active Apps and isolated cold recovery; no workspace traversal. */
export function createAppArtifactStore(storageRoot: string) {
  return createNodeToolArtifactStore({
    imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
    pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
    rootDir: join(storageRoot, "cli", "artifacts"),
    videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
  });
}
