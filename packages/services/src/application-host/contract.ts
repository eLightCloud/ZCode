import { createServiceDescriptor } from "../descriptors.js";
import type { AutomationInputAdmission } from "@zcode/shared";

/** Launcher-only capability. Do not register this port on browser RPC. */
export type ApplicationAutomationAdmission =
  | "admitted"
  | "blocked"
  | "unavailable"
  | {
      state: "admitted";
      context: { filename: string; text: string };
    };
export interface ApplicationHostControlPort {
  control(method: string, input: unknown): Promise<unknown>;
  beforeAutomationInput(input: AutomationInputAdmission): Promise<ApplicationAutomationAdmission>;
}

/** Trusted optional application bridge. Native execution semantics never enter this channel. */
export interface IApplicationHostService {
  call(method: string, input: unknown): Promise<unknown>;
}
export const IApplicationHostService =
  createServiceDescriptor<IApplicationHostService>("application-host");
