import { conversationEffectSchema } from "@zcode/shared";
import { PersistedToolSearchContentSchema } from "@zcode/contracts";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type CompletedToolPartMetadata,
  type ToolExecutionResult,
} from "../deps.js";
import { createMcpToolDisplay } from "../../tool/execution-host-api.js";

export function mcpToolPartMetadata(
  presentation:
    | { readOnly?: boolean; serverName: string; toolName: string; description?: string }
    | undefined,
): CompletedToolPartMetadata | undefined {
  const display = createMcpToolDisplay(presentation);
  return display
    ? {
        schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
        display,
        ...(presentation?.readOnly !== undefined ? { mcpReadOnly: presentation.readOnly } : {}),
      }
    : undefined;
}

export function completedToolPartMetadata(
  result: ToolExecutionResult,
  capability?: { readOnly: boolean; sideEffectScope: string },
): CompletedToolPartMetadata {
  const modelContent = PersistedToolSearchContentSchema.safeParse(result.modelContent);
  const serialization = result.serialization
    ? {
        truncated: result.serialization.truncated,
        originalBytes: result.serialization.originalBytes,
        returnedBytes: result.serialization.returnedBytes,
        budgetStrategy: result.serialization.budgetStrategy,
        ...(result.serialization.artifactUri
          ? { artifactUri: result.serialization.artifactUri }
          : {}),
        ...(result.serialization.artifactPath
          ? { artifactPath: result.serialization.artifactPath }
          : {}),
      }
    : undefined;
  const output = result.output;
  const meta = output && typeof output === "object" && "_meta" in output ? output._meta : null;
  const effect = conversationEffectSchema.safeParse(
    meta && typeof meta === "object" && "zcode/effect" in meta ? meta["zcode/effect"] : null,
  );
  return {
    ...(capability
      ? {
          readOnly: capability.readOnly,
          sideEffectScope:
            capability.sideEffectScope as CompletedToolPartMetadata["sideEffectScope"],
        }
      : {}),
    ...(meta &&
    typeof meta === "object" &&
    "zcode/readOnly" in meta &&
    typeof meta["zcode/readOnly"] === "boolean"
      ? { mcpReadOnly: meta["zcode/readOnly"] }
      : {}),
    ...(effect.success ? { businessEffect: effect.data } : {}),
    schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
    ...(modelContent.success ? { modelContent: modelContent.data } : {}),
    ...(result.display ? { display: result.display } : {}),
    ...(serialization ? { serialization } : {}),
    // resume 需要恢复模型当时真实读到的文件快照；只依赖 tool_result 文本
    // 会把主路径绑死在 provider 展示格式上，所以新 session 结构化持久化 read-state。
    ...(result.readFileStateMetadata ? { readFileState: result.readFileStateMetadata } : {}),
  };
}
