import type { ReactNode } from "react";
import type { CreateTaskOptions } from "@/app-shell/types.js";
export interface WorkspaceEntry {
  onPrepare(options?: CreateTaskOptions): void;
  content: ReactNode;
  pending?: boolean;
}
export { WorkspaceEntryContent } from "./WorkspaceEntryContent.js";
