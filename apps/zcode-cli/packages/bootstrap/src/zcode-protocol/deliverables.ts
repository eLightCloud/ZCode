import { join } from "node:path";
import { NodeDeliverableStore } from "@zcode/adapters/storage";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import {
  zcodeDeliverablesListParamsSchema,
  zcodeDeliverableReadParamsSchema,
  zcodeDeliverableReleaseParamsSchema,
} from "@zcode/shared";
import { getCliStorageRoot } from "../app/paths.js";

/** 独立原生读面，不恢复会话、不接纳输入，也不要求生成会话仍驻留。 */
export async function queryNativeDeliverables(kind: "list" | "read" | "release", raw: unknown) {
  const input =
    kind === "list"
      ? zcodeDeliverablesListParamsSchema.parse(raw)
      : kind === "release"
        ? zcodeDeliverableReleaseParamsSchema.parse(raw)
        : zcodeDeliverableReadParamsSchema.parse(raw);
  const config = createConfig({ workingDirectory: input.workspacePath });
  const store = new NodeDeliverableStore(
    join(getCliStorageRoot(resolvePath(config.config.storage.dir)), "deliverables"),
  );
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  try {
    if (kind === "list") {
      const list = zcodeDeliverablesListParamsSchema.parse(raw);
      return await store.list({ workspaceKey, after: list.after, limit: list.limit });
    }
    if (kind === "release") {
      const release = zcodeDeliverableReleaseParamsSchema.parse(raw);
      await store.release({
        workspaceKey,
        id: release.id,
        version: release.version,
        sha256: release.sha256,
      });
      return { released: true as const };
    }
    const read = zcodeDeliverableReadParamsSchema.parse(raw);
    const bytes = await store.read({
      workspaceKey,
      id: read.id,
      version: read.version,
      offset: read.offset,
      length: read.length,
    });
    return { dataBase64: Buffer.from(bytes).toString("base64") };
  } finally {
    store.close();
  }
}
