import type { PluginManifest } from "@zcode/contracts";

import { isRecord } from "./helpers.js";

import type {
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  PluginValidationDiagnostic,
} from "./marketplace-contracts.js";

import {
  readOptionalZipPluginSourcePath,
  readOptionalZipPluginSourceStripRoot,
  readPluginSourceHeaders,
  readRequiredPluginSourceString,
  readRequiredZipPluginSourceSha256,
} from "./marketplace-source.js";

import { SOURCE_SHA256_PATTERN } from "./marketplace-constants.js";

import {
  pushManifestCompatibilityDiagnostics,
  toValidationDiagnostic,
} from "./marketplace-plugin-validation.js";

import { createManifestFromMarketplaceEntry } from "./marketplace-manifest.js";

import { resolveDependencyClosureFromManifest } from "./marketplace-dependencies.js";

export function validateMarketplaceEntryShape(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  options: { includeEntryCompatibility?: boolean } = {},
): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${entry.name}@${marketplace}`;
  if (entry.source === undefined) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Plugin has no install source: ${pluginId}`,
      pluginId,
      severity: "error",
    });
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "npm" || sourceKind === "pip") {
      diagnostics.push({
        code: "plugin_marketplace_source_unsupported",
        message: `Plugin source is recognized but not supported in V1 install: ${sourceKind}`,
        pluginId,
        severity: "warning",
      });
    }
    if (sourceKind === "url") {
      const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
      if (sourceType && sourceType !== "git" && sourceType !== "zip") {
        diagnostics.push({
          code: "plugin_marketplace_source_unsupported",
          message: `Plugin URL source type is not supported: ${sourceType}`,
          pluginId,
          severity: "error",
        });
      }
      try {
        readRequiredPluginSourceString(entry.source, "url", "URL");
        if (sourceType === "zip") {
          const sha256 = readRequiredZipPluginSourceSha256(entry.source).toLowerCase();
          if (!SOURCE_SHA256_PATTERN.test(sha256)) {
            throw new Error("Plugin zip source sha256 must be a 64 character hex string");
          }
          readPluginSourceHeaders(entry.source);
          readOptionalZipPluginSourcePath(entry.source);
          readOptionalZipPluginSourceStripRoot(entry.source);
        }
      } catch (error) {
        diagnostics.push({
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId,
          severity: "error",
        });
      }
    }
  }
  if (options.includeEntryCompatibility !== false) {
    pushEntryCompatibilityDiagnostics({ diagnostics, entry, marketplace });
  }
  return diagnostics;
}

export function pushEntryCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry: PluginMarketplaceEntry;
  marketplace: string;
}): void {
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  pushManifestCompatibilityDiagnostics({
    diagnostics: input.diagnostics,
    manifest: createManifestFromMarketplaceEntry(input.entry) as unknown as PluginManifest,
    manifestPath: pluginId,
    pluginId,
    source: "cache",
  });
}

export function getMarketplaceSourceValidationDeferral(
  entry: PluginMarketplaceEntry,
  marketplace: string,
): PluginValidationDiagnostic | null {
  if (!isRecord(entry.source)) return null;
  const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
  if (sourceKind === "url") {
    const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
    if (sourceType && sourceType !== "git" && sourceType !== "zip") return null;
  }
  if (!["github", "git", "url", "git-subdir"].includes(sourceKind)) return null;
  const pluginId = `${entry.name}@${marketplace}`;
  const sourceLabel =
    typeof entry.source.repo === "string"
      ? entry.source.repo
      : typeof entry.source.url === "string"
        ? entry.source.url
        : sourceKind;
  return {
    code: "plugin_validation_deferred",

    // 聚合市场可能包含大量外部 git source；市场级 validate 不逐个 clone，单插件安装或校验时
    // 再深扫目标 root，避免设置页被网络操作拖到协议超时。
    message: `Remote plugin source validation is deferred until install or single-plugin validate: ${sourceLabel}`,
    pluginId,
    severity: "warning",
  };
}

export function pushDependencyDiagnosticsFromManifest(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginMarketplaceManifest;
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    resolveDependencyClosureFromManifest({
      allowCrossMarketplaces: new Set(input.manifest.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      manifest: input.manifest,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}
