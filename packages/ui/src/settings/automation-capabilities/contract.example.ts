/**
 * automation-capabilities 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { useAutomationCapabilities } from "./index.js";
import type { AutomationCapabilityReader } from "./contract.js";

export function useExampleAutomationCapabilities(reader: AutomationCapabilityReader) {
  return useAutomationCapabilities(reader);
}
