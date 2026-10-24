import {
  CoreErrorType,
  createCoreError,
  DELIVER_FILES_TOOL_NAME,
  DeliverFilesInputSchema,
  DeliverFilesOutputSchema,
  DeliverFilesInputJsonSchema,
  DeliverFilesOutputJsonSchema,
} from "@zcode/contracts";
import { resolve } from "node:path";
import { wildcardToRegExp } from "../../permission/rule-matching.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const OUTPUT_BYTES = 128 * 1024;
const DESCRIPTION =
  "Deliver final files explicitly requested by the user. Call after the files are ready, " +
  "before your final answer. Paths are absolute or relative to the workspace root. " +
  "Snapshots preserve these exact bytes. Include every final file, even " +
  "CSV, ZIP, images or files without previews. Do not deliver inputs, logs, intermediate work, " +
  "or unreviewed subagent output. Revisions require the exact previous delivery id and version.";
const KNOWN_FAILURES = new Set([
  "deliverable_source_outside_workspace",
  "deliverable_source_not_regular",
  "deliverable_source_changed",
  "deliverable_revision_conflict",
  "deliverable_request_conflict",
  "deliverable_name_invalid",
]);

export const deliverFilesHandler: ToolHandler = async (raw, context) => {
  const input = DeliverFilesInputSchema.parse(raw);
  const store = context.deliverableStore;
  if (!store)
    throw createCoreError(CoreErrorType.ConfigurationError, "File delivery store is unavailable", {
      recoverable: false,
    });
  const producerContextRef = context.getProducerContextRef?.();
  const files = [];
  for (const [index, item] of input.files.entries()) {
    context.abortSignal.throwIfAborted();
    try {
      const file = await store.publish(
        {
          workspaceKey: context.workspaceIdentity?.trim() || context.workspaceRoot,
          workspacePath: context.workspaceRoot,
          sessionId: context.sessionId,
          turnId: context.turnId,
          producerContextRef,
          requestKey: `${context.toolCallId}:${index}`,
          sourcePath: item.path,
          previous: item.previous,
          trace: context.traceContext ?? {
            traceId: context.traceId,
            sessionId: context.sessionId,
            turnId: context.turnId,
            spanId: context.spanId,
          },
        },
        { signal: context.abortSignal },
      );
      files.push({ status: "delivered" as const, file });
    } catch (error) {
      context.abortSignal.throwIfAborted();
      const code =
        error instanceof Error && KNOWN_FAILURES.has(error.message)
          ? error.message
          : "deliverable_snapshot_failed";
      files.push({ status: "failed" as const, index, code });
    }
  }
  return DeliverFilesOutputSchema.parse({ files });
};

export const deliverFilesToolEntry: ToolEntry = {
  capability: "Declare explicit final files and preserve immutable snapshots",
  metadata: {
    name: DELIVER_FILES_TOOL_NAME,
    shouldDefer: true,
    description: DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 120000,
    maxOutputBytes: OUTPUT_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: deliverFilesHandler,
  inputSchema: DeliverFilesInputJsonSchema,
  outputSchema: DeliverFilesOutputJsonSchema,
  runtimeInputSchema: DeliverFilesInputSchema,
  runtimeOutputSchema: DeliverFilesOutputSchema,
  resolvePermissionRulePolicy(raw, context) {
    const input = DeliverFilesInputSchema.parse(raw);
    const workspaceRoot = context?.workspaceRoot;
    const subjects = input.files.map(({ path }) =>
      workspaceRoot ? [path, resolve(workspaceRoot, path)] : [path],
    );
    return {
      // 多文件 deny / ask 匹配任一项，allow 必须覆盖全部项，不能只看顶层 path。
      evaluateRules(behavior, rules) {
        const matched = (paths: string[]) =>
          rules.some(
            (rule) =>
              !rule.ruleContent ||
              paths.some((path) => wildcardToRegExp(rule.ruleContent!).test(path)),
          );
        return behavior === "allow" ? subjects.every(matched) : subjects.some(matched);
      },
      suggestedPermissionUpdates: [],
    };
  },
  permission: {
    permission: "read",
    reason: "Copies explicit files into native delivery snapshots",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: OUTPUT_BYTES,
    maxModelBytes: OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 120000, maxMs: 120000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "required",
    userVisibleMessage: "File delivery cancelled; completed snapshots remain available",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
