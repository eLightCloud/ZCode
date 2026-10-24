import { expect, it } from "vitest";
import { createMcpAppProvidedToolEntry } from "../../src/tool/contract.js";
it("does not trust an app-provided tool to omit permission and effect metadata", () => {
  const entry = createMcpAppProvidedToolEntry(
    {
      modelName: "app__owned__write",
      serverName: "owned",
      pluginId: "owned",
      scopeId: "owned-view",
      generation: 1,
      toolName: "write",
      inputSchema: { type: "object", properties: {} },
    },
    async () => ({ content: [] }),
  );
  expect(entry.metadata).toMatchObject({
    readOnly: false,
    needsApproval: true,
    riskLevel: "medium",
    sideEffectScope: "network",
  });
  expect(entry.permission).toMatchObject({ needsApproval: true, denyPriority: "beforeAsk" });
});
