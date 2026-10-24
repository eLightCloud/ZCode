import { describe, expect, it, vi } from "vitest";
import type { McpPort, McpCallToolRequest, McpToolCallResult } from "@zcode/contracts";
import { createMcpToolEntry } from "../src/mcp/index.js";

const effect = {
  server: "synthetic-business",
  owner: "synthetic-owner",
  operation: "mail-original",
  requestKey: "key-original",
  receiptUri: "mcp-effect://mail-original",
  outcome: "applied",
};
function setup(decision = "proceed", readOnly = false) {
  const write = vi.fn(async () => ({ content: [{ type: "text", text: "SYNTHETIC_NEW_RECEIPT" }] }));
  const check = vi.fn(
    async (request: McpCallToolRequest): Promise<McpToolCallResult> => ({
      content: [],
      structuredContent: {
        decision,
        action: request.arguments?.action,
        result: {
          content: [{ type: "text", text: "SYNTHETIC_ORIGINAL_RECEIPT" }],
          _meta: { "zcode/effect": effect },
        },
      },
    }),
  );
  const port = {
    listTools: async () => [
      {
        serverName: effect.server,
        toolName: "check_operation",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: (request: McpCallToolRequest) =>
      request.toolName === "check_operation" ? check(request) : write(),
  } as unknown as McpPort;
  const entry = createMcpToolEntry(
    "mcp__synthetic_business__send",
    {
      serverName: effect.server,
      toolName: "send",
      effectCheckTool: "check_operation",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: readOnly },
    },
    port,
    false,
  );
  const context = {
    sessionId: "synthetic-session",
    traceId: "synthetic-trace",
    toolCallId: "new-call",
    abortSignal: new AbortController().signal,
    workingDirectory: "synthetic-workspace",
    sessionStore: {
      sessionEntries: async () => [{ type: "runtime/branch_effects", data: [effect] }],
    },
  };
  return { entry, context, port, write, check };
}
describe("cross-branch resource owner reconciliation", () => {
  it("queries the resource owner before an independently confirmed new action", async () => {
    const { entry, context, write, check } = setup();
    await entry.handler({ requestKey: "key-new" }, context as never);
    expect(check).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]![0].arguments?.effects).toEqual([effect]);
    expect(check.mock.calls[0]![0]).toMatchObject({
      workspacePath: "synthetic-workspace",
      workspaceKey: "synthetic-workspace",
      runtimeScope: "main",
      trace: { traceId: "synthetic-trace", sessionId: "synthetic-session" },
    });
  });
  it("returns the owner's original receipt for the original request without another write", async () => {
    const { entry, context, write } = setup("replay");
    const result = await entry.handler({ requestKey: "key-original" }, context as never);
    expect(JSON.stringify(result)).toContain("SYNTHETIC_ORIGINAL_RECEIPT");
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["unknown", "blocked", "requires_confirmation"])(
    "blocks %s without inventing a new request",
    async (decision) => {
      const { entry, context, write } = setup(decision);
      await expect(
        entry.handler({ requestKey: "different-key" }, context as never),
      ).rejects.toThrow("branch_effect_verification_required");
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("does not let a mismatched owner response authorize the proposed action", async () => {
    const { entry, context, check, write } = setup();
    check.mockImplementationOnce(async () => ({
      content: [],
      structuredContent: {
        decision: "proceed",
        action: { tool: "other", arguments: {} },
        result: { content: [] },
      },
    }));
    await expect(entry.handler({}, context as never)).rejects.toThrow(
      "branch_effect_result_unknown",
    );
    expect(write).not.toHaveBeenCalled();
  });
  it("requires a read-only check capability and keeps unrelated reads available", async () => {
    const { entry, context, port, write } = setup();
    port.listTools = async () => [];
    await expect(entry.handler({}, context as never)).rejects.toThrow(
      "branch_effect_verification_required",
    );
    expect(write).not.toHaveBeenCalled();
    const read = setup("unknown", true);
    await read.entry.handler({}, read.context as never);
    expect(read.write).toHaveBeenCalledOnce();
    expect(read.check).not.toHaveBeenCalled();
  });
  it.each(["other-server", "unknown-outcome", "wrong-operation", "malformed-result"])(
    "rejects %s replay evidence",
    async (fault) => {
      const { entry, context, check, write } = setup("replay");
      const receipt = {
        ...effect,
        ...(fault === "other-server" ? { server: "foreign" } : {}),
        ...(fault === "unknown-outcome" ? { outcome: "unknown" } : {}),
        ...(fault === "wrong-operation" ? { operation: "foreign" } : {}),
      };
      check.mockImplementationOnce(async (request) => ({
        content: [],
        structuredContent: {
          decision: "replay",
          action: request.arguments?.action,
          result:
            fault === "malformed-result"
              ? { content: "invalid" }
              : { content: [], _meta: { "zcode/effect": receipt } },
        },
      }));
      await expect(entry.handler({ requestKey: "key-original" }, context as never)).rejects.toThrow(
        "branch_effect_result_unknown",
      );
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("keeps writes closed if resource verification fails or stored effects are malformed", async () => {
    const { entry, context, check, write } = setup();
    check.mockRejectedValueOnce(new Error("synthetic_resource_offline"));
    await expect(entry.handler({}, context as never)).rejects.toThrow("synthetic_resource_offline");
    context.sessionStore.sessionEntries = async () => [
      { type: "runtime/branch_effects", data: [{ ...effect, outcome: "invalid" }] },
    ];
    await expect(entry.handler({}, context as never)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
