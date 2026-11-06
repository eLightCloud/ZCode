import type { AutomationExecutionCapabilities } from "@zcode/shared";

export type AutomationCapabilities = AutomationExecutionCapabilities;
export interface AutomationCapabilityReader {
  getAutomationCapabilities(): Promise<AutomationExecutionCapabilities>;
}
export type AutomationCapabilityState =
  | { status: "loading" | "unavailable" | "error" }
  | { status: "ready"; value: AutomationCapabilities };

