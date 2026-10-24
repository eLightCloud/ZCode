// @vitest-environment node
import { expect, it } from "vitest";
import { SourceServerOperationLogs } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  const logs = new SourceServerOperationLogs(() => 1);
  expect(logs.read({ profileId: "missing" })).toEqual([]);
  logs.removeProfile("missing");
  expect(logs.read({ profileId: "missing" })).toEqual([]);
});
