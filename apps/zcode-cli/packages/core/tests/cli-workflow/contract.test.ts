import { expect, it } from "vitest";
import {
  cancelWorkflowSnapshot,
  DEFAULT_EXPERT_WORKFLOW_STRATEGY,
  type WorkflowRunSnapshot,
} from "../../src/workflow/contract.js";
it("cancels a workflow snapshot without mutating the caller's state", () => {
  const snapshot: WorkflowRunSnapshot = {
    activities: [],
    artifacts: [],
    createdAt: "2026-10-25T00:00:00Z",
    cwd: "owned-fixture",
    graph: { nodes: [], edges: [] },
    kind: "expert",
    phaseOrder: [],
    phases: [],
    runId: "owned-workflow",
    schemaVersion: 1,
    status: "running",
    strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
    task: "owned fixture",
    updatedAt: "2026-10-25T00:00:00Z",
  };
  const result = cancelWorkflowSnapshot(snapshot, { timestamp: "2026-10-25T00:01:00Z" });
  expect(result.snapshot.status).toBe("cancelled");
  expect(snapshot.status).toBe("running");
  expect(result.snapshot).not.toBe(snapshot);
});
