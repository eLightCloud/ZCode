import type { PluginDiscoverRequest, PluginLoadOutcome, PluginPort } from "./contract.js";

/** Bootstrap supplies the trusted storage root; callers do not write the install registry. */
export function discoverConfiguredPlugins(
  plugin: PluginPort,
  request: PluginDiscoverRequest,
): Promise<PluginLoadOutcome> {
  return plugin.discoverPlugins(request);
}
