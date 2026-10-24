import { expect, it } from "vitest";
import { sanitizeHookDiagnostics } from "../../src/hooks/contract.js";
it("keeps hook diagnostics bounded and masks synthetic secret fields", () => {
  const result = sanitizeHookDiagnostics({
    stderrPreview: "api_key=owned-synthetic-value",
    stdoutPreview: "x".repeat(5000),
  });
  expect(result?.stderrPreview).not.toContain("owned-synthetic-value");
  expect(result?.stdoutPreview).toHaveLength(4000);
});
