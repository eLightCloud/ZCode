import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey, zcodeTaskMetaSchema, type ZCodeTaskMeta } from "@zcode/shared";

export const CONVERSATION_CLASSIFICATION_SQL = `CREATE TABLE conversation_workspace_purpose (
  workspace_key TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose='conversation'))`;

/** Native ensure owns this fact. Existing unknown rows are never reclassified by path. */
export function preserveConversationPurpose(
  db: DatabaseSync,
  meta: ZCodeTaskMeta,
  previous: string | null,
): ZCodeTaskMeta {
  if (meta.workspacePurpose !== undefined) return meta;
  if (previous !== null) {
    let parsed;
    try {
      parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(previous));
    } catch {
      return meta;
    }
    return parsed.success && parsed.data.workspacePurpose
      ? { ...meta, workspacePurpose: parsed.data.workspacePurpose }
      : meta;
  }
  const known = db
    .prepare("select purpose from conversation_workspace_purpose where workspace_key=?")
    .get(resolveWorkspaceKey(meta));
  return known?.purpose === "conversation" ? { ...meta, workspacePurpose: "conversation" } : meta;
}
