import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTraceId,
  toolResultDisplayPayloadSchema,
  type PublishDeliverableInput,
} from "@zcode/contracts";
import { deliverFilesHandler, deliverFilesToolEntry } from "../src/tool/handlers/deliver-files.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { buildSessionGuidanceSection } from "../src/context/dynamic-sections.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import { nativeDeliverFilesDisplaySchema } from "@zcode/shared";

describe("DeliverFiles", () => {
  it("freezes original input correlation for every file and reports partial failure honestly", async () => {
    let currentInput = "original-input";
    const publish = vi.fn(async (input: PublishDeliverableInput) => {
      currentInput = "later-input";
      if (input.sourcePath === "missing") throw new Error("private filesystem error");
      return {
        kind: "file" as const,
        purpose: "final" as const,
        id: randomUUID(),
        version: 1,
        sequence: publish.mock.calls.length,
        workspaceKey: input.workspaceKey,
        sessionId: input.sessionId,
        requestKey: input.requestKey,
        name: input.sourcePath,
        size: 0,
        sha256: "0".repeat(64),
        createdAt: new Date().toISOString(),
        producerContextRef: input.producerContextRef,
      };
    });
    const context: ToolExecutionContext = {
      toolCallId: "stable-tool-call",
      traceId: createTraceId(),
      traceContext: createRootTraceContext(),
      abortSignal: new AbortController().signal,
      sessionId: createSessionId(),
      workspaceRoot: "/synthetic",
      workingDirectory: "/synthetic",
      getProducerContextRef: () => currentInput,
      deliverableStore: {
        publish,
        list: async () => ({ entries: [], cursor: 0 }),
        read: async () => new Uint8Array(),
        close() {},
      },
    };
    const output = await deliverFilesHandler(
      { files: [{ path: "first.csv" }, { path: "second.zip" }, { path: "missing" }] },
      context,
    );
    expect(publish.mock.calls.map(([input]) => input.producerContextRef)).toEqual([
      "original-input",
      "original-input",
      "original-input",
    ]);
    expect(publish.mock.calls.map(([input]) => input.requestKey)).toEqual([
      "stable-tool-call:0",
      "stable-tool-call:1",
      "stable-tool-call:2",
    ]);
    expect(output).toMatchObject({
      files: [
        { status: "delivered" },
        { status: "delivered" },
        { status: "failed", index: 2, code: "deliverable_snapshot_failed" },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("private filesystem error");
    const display = createToolResultDisplay("DeliverFiles", output);
    expect(toolResultDisplayPayloadSchema.safeParse(display).success).toBe(true);
    expect(nativeDeliverFilesDisplaySchema.parse(display).result.files).toEqual(output.files);
    expect(
      createToolResultDisplay("DeliverFiles", {
        files: [{ status: "delivered", file: { path: "/private" } }],
      }),
    ).toBeUndefined();
  });
  it("exposes delivery and its guidance only when the native capability is present", () => {
    const without = createToolRegistry();
    registerBuiltInTools(without);
    expect(without.has("DeliverFiles")).toBe(false);
    const withStore = createToolRegistry();
    registerBuiltInTools(withStore, { includeDeliverables: true });
    expect(withStore.has("DeliverFiles")).toBe(true);
    expect(buildSessionGuidanceSection(["DeliverFiles"])?.content).toContain(
      "before your final answer",
    );
    expect(buildSessionGuidanceSection([])).toBeNull();
  });
});

it("enforces project permission patterns across every declared file", () => {
  const input = { files: [{ path: "public.csv" }, { path: "private/secret.csv" }] };
  const policy = deliverFilesToolEntry.resolvePermissionRulePolicy!(input, {
    workspaceRoot: "/workspace",
  });
  expect(
    policy.evaluateRules("deny", [
      { toolName: "DeliverFiles", ruleContent: "/workspace/private/*" },
    ]),
  ).toBe(true);
  expect(
    policy.evaluateRules("ask", [{ toolName: "DeliverFiles", ruleContent: "private/*" }]),
  ).toBe(true);
  expect(
    policy.evaluateRules("allow", [{ toolName: "DeliverFiles", ruleContent: "public.csv" }]),
  ).toBe(false);
  expect(
    policy.evaluateRules("allow", [{ toolName: "DeliverFiles", ruleContent: "/workspace/*" }]),
  ).toBe(true);
});
