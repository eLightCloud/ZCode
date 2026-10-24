// @vitest-environment node
import { expect, it } from "vitest";
import { foldWorkflowRunRail, selectWorkflowRunLines, countLiveWorkflowRuns } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  expect(selectWorkflowRunLines(undefined, () => false)).toEqual({ lines: [], overflow: 0 });
  expect(
    foldWorkflowRunRail([
      { name: "A", status: "running" },
      { name: "B", status: "pending" },
    ]).stations.map((x) => x.status),
  ).toEqual(["running", "pending"]);
  expect(countLiveWorkflowRuns(undefined)).toBe(0);
});
