// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export const READ_FILE_STATE_METADATA_SCHEMA_VERSION = 1;

// `CreateWorkflow` / `AmendWorkflow` / `FillWorkflowHole`：内联草稿（或 fill 文件）的字节就是模型那次
// 调用的 `script` 入参，与 Write 同理记作完整视图（handlers/workflow-draft-read-state.ts）。
export type PersistedReadFileStateTool =
  | "Read"
  | "Write"
  | "Edit"
  | "CreateWorkflow"
  | "AmendWorkflow"
  | "FillWorkflowHole";

export interface PersistedReadFileStateMetadata {
  schemaVersion: typeof READ_FILE_STATE_METADATA_SCHEMA_VERSION;
  tool: PersistedReadFileStateTool;
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAtMs: number;
  revisionId: string;
  mtimeMs: number;
  sizeBytes: number;
}
