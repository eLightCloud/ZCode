import { PermissionService } from "./contract.js";
export function examplePermission() {
  return new PermissionService().checkPermission({
    toolName: "WebSearch",
    input: { query: "owned fixture" },
    mode: "build",
    riskLevel: "low",
  });
}
