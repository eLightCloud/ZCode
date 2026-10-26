import type { WorkspaceEntry } from "./contract.js";
export const exampleWorkspaceEntry = (onPrepare: WorkspaceEntry["onPrepare"]): WorkspaceEntry => ({
  onPrepare,
  content: "Start work",
});
