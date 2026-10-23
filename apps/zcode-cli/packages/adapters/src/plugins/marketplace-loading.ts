import { readFile } from "node:fs/promises";

import { dirname, isAbsolute, join } from "node:path";

import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";

import { activateDirectoryAtomically, type AtomicDirectoryActivation } from "./atomic-directory.js";

import { UnsupportedMarketplaceSourceError } from "./marketplace-contracts.js";

import type { LoadMarketplaceResult, MarketplaceSource } from "./marketplace-contracts.js";

import { throwIfPluginOperationAborted } from "./marketplace-operation-signal.js";

import {
  findMarketplaceManifestPath,
  getMarketplaceManifestPath,
  normalizeMarketplaceManifest,
  parseRequiredMarketplaceManifest,
} from "./marketplace-manifest.js";

import { requestMarketplaceJson } from "./marketplace-icons.js";

import {
  isGitSshUrl,
  resolveRepositoryMarketplaceSource,
  splitGitHubShorthand,
  splitRef,
} from "./marketplace-source.js";

import { KNOWN_MARKETPLACES_FILE, MARKETPLACE_FILE } from "./marketplace-constants.js";

import { writeJsonFile } from "./marketplace-json-files.js";

export async function loadMarketplaceFromSource(
  source: MarketplaceSource,
  storageRoot: string,
  options: { persist: boolean; signal?: AbortSignal },
): Promise<LoadMarketplaceResult> {
  throwIfPluginOperationAborted(options.signal);
  switch (source.source) {
    case "settings":
      return { manifest: normalizeMarketplaceManifest(source.marketplace) };
    case "file": {
      const parsed = JSON.parse(await readFile(source.path, "utf8")) as unknown;
      return {
        manifest: parseRequiredMarketplaceManifest(parsed),
        sourceRoot: dirname(source.path),
      };
    }
    case "directory": {
      const file = findMarketplaceManifestPath(source.path);
      if (!file) throw new Error(`Marketplace manifest not found in directory: ${source.path}`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const manifest = parseRequiredMarketplaceManifest(parsed);
      if (options.persist) {
        const activation = await stageMarketplaceDirectoryPlugins(
          source.path,
          storageRoot,
          manifest.name,
          manifest.raw,
          options.signal,
        );
        await activation.finalize();
      }
      return { manifest, sourceRoot: source.path };
    }
    case "url": {
      const parsed = await requestMarketplaceJson(source.url, source.headers, options.signal);
      return { manifest: parseRequiredMarketplaceManifest(parsed) };
    }
    case "github": {
      const resolved = await resolveRepositoryMarketplaceSource(
        `https://github.com/${source.repo}.git`,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in GitHub repo: ${source.repo}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "git": {
      const resolved = await resolveRepositoryMarketplaceSource(
        source.url,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in git repo: ${source.url}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "npm":
      throw new UnsupportedMarketplaceSourceError("npm");
    case "hostPattern":
      throw new UnsupportedMarketplaceSourceError("hostPattern");
    case "pathPattern":
      throw new UnsupportedMarketplaceSourceError("pathPattern");
  }
}

export async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal);
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir,
  });
}

export async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // URL/settings source 没有 sourceRoot；直接覆盖 manifest 时若写入期间
  // deadline 到达或 known state 落盘失败就无法回滚。prepare-only activation 让 manifest
  // 与 known_marketplaces.json 使用同一个 transactionId 提交，失败时继续读取上一代快照。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    targetPath: targetDir,
  });
}

export async function writeMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(getMarketplaceManifestPath(storageRoot, marketplace), raw);
}

export function defaultMarketplaceSourceFromString(source: string): MarketplaceSource {
  const trimmed = source.trim();
  if (isAbsolute(trimmed)) return { source: "file", path: trimmed };
  // scp 风格 SSH（git@host:path[#ref]）是受控私有源的常规寻址；#fragment 为固定提交。
  if (isGitSshUrl(trimmed)) {
    const { ref, url } = splitRef(trimmed);
    return ref ? { source: "git", url, ref } : { source: "git", url };
  }
  if (/^[^/]+\/[^/]+(?:[#@].+)?$/u.test(trimmed) && !trimmed.includes(":")) {
    const { ref, url } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo: url, ref } : { source: "github", repo: url };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const { ref, url } = splitRef(trimmed);
    if (url.endsWith(".git") || url.includes("/_git/")) {
      return ref ? { source: "git", url, ref } : { source: "git", url };
    }
    return { source: "url", url: trimmed };
  }
  return { source: "url", url: trimmed };
}
