import { cancelWorkflowSnapshot, type WorkflowRunSnapshot } from "./contract.js";
export function exampleCancel(snapshot: WorkflowRunSnapshot, timestamp: string) {
  return cancelWorkflowSnapshot(snapshot, { timestamp });
}
