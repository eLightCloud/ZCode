import { parsePluginId, qualifyDependency } from "./marketplace-identifiers.js";

import { loadMarketplaceManifestSync } from "./marketplace-manifest.js";

import type {
  PluginMarketplaceManifest,
  PluginValidationDiagnostic,
} from "./marketplace-contracts.js";

import { toValidationDiagnostic } from "./marketplace-plugin-validation.js";

export function resolveDependencyClosure(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;
    const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);
    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

export function resolveDependencyClosureFromManifest(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  manifest: PluginMarketplaceManifest;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const loadManifest = (marketplace: string): PluginMarketplaceManifest | null =>
    marketplace === input.marketplace
      ? input.manifest
      : loadMarketplaceManifestSync(input.storageRoot, marketplace);

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;

    const manifest = loadManifest(marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);

    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

export function pushDependencyDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    resolveDependencyClosure({
      allowCrossMarketplaces: new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}
