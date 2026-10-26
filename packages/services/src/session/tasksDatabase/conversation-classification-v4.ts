import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey, zcodeTaskMetaSchema, type ZCodeTaskMeta } from "@zcode/shared";
import { basename, dirname, resolve } from "node:path";
import { getConversationWorkspaceDir } from "../../paths.js";

/** Namespace guard only. Existing rows still need native purpose or explicit legacy attribution. */
export function isConversationWorkspaceCandidate(path: string): boolean {
  const root = resolve(getConversationWorkspaceDir());
  const candidate = resolve(path);
  return (
    candidate === root ||
    (dirname(candidate) === dirname(root) &&
      /^(?:draft-|\d+-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        basename(candidate),
      ))
  );
}

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
