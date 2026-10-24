import { expect, it } from "vitest";
import { PermissionService, defaultPermissionConfig } from "../../src/permission/contract.js";
it("keeps explicit deny stronger than a tool request for user approval", () => {
  const service = new PermissionService({
    ...defaultPermissionConfig,
    disallowedTools: new Set(["OwnedTool"]),
  });
  const decision = service.checkPermission(
    { toolName: "OwnedTool", input: {}, mode: "build", riskLevel: "high" },
    {
      readOnly: false,
      destructive: true,
      needsApproval: true,
      riskLevel: "high",
      sideEffectScope: "system",
      permission: {
        permission: "bash",
        needsApproval: true,
        riskLevel: "high",
        sideEffectScope: "system",
        denyPriority: "beforeAsk",
      },
    },
  );
  expect(decision).toMatchObject({
    allowed: false,
    decision: "deny",
    ruleId: "rule.disallowedTools",
  });
});
