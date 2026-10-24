// @vitest-environment node
import { expect, it } from "vitest";
import { createSyncWorkspaceFileSearchFilterBackend } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  const backend = createSyncWorkspaceFileSearchFilterBackend();
  backend.setPacked("", "/synthetic");
  expect(await backend.filter("query", { limit: 2 })).toEqual([]);
  backend.dispose();
  expect(await backend.filter("query", { limit: 2 })).toEqual([]);
});
