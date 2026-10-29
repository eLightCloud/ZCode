import {
  describeZCodePlugin,
  validateZCodePluginPath,
  type DescribeZCodePluginOptions,
  type ValidateZCodePluginPathOptions,
} from "./contract.js";
/** Explicit paths are inspected without installing or changing enabled state. */
export async function examplePluginInspection(options: ValidateZCodePluginPathOptions) {
  return await validateZCodePluginPath(options);
}

/** Update preflight checks the source while keeping the installed version intact. */
export async function examplePluginUpdateInspection(options: DescribeZCodePluginOptions) {
  return await describeZCodePlugin({ ...options, source: "marketplace" });
}
