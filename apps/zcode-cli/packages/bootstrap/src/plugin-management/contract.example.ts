import { validateZCodePluginPath, type ValidateZCodePluginPathOptions } from "./contract.js";
/** Explicit paths are inspected without installing or changing enabled state. */
export async function examplePluginInspection(options: ValidateZCodePluginPathOptions) {
  return await validateZCodePluginPath(options);
}
