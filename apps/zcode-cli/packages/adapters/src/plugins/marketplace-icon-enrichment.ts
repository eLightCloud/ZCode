import { resolve } from "node:path";

import {
  CLAUDE_OFFICIAL_MARKETPLACE,
  claudeIconMigrationAttempts,
} from "./marketplace-constants.js";

import { loadMarketplaceManifestSync } from "./marketplace-manifest.js";

import { applyClaudePluginIcons, loadClaudePluginIconSources } from "./marketplace-icons.js";

import { writeMarketplaceManifest } from "./marketplace-loading.js";

export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock: (write: () => Promise<void>) => Promise<void> = (write) => write(),
): Promise<void> {
  const attemptKey = resolve(storageRoot);
  if (claudeIconMigrationAttempts.has(attemptKey)) return;
  claudeIconMigrationAttempts.add(attemptKey);

  const manifest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
  if (!manifest) return;
  try {
    const iconSources = await loadClaudePluginIconSources(storageRoot);
    await withWriteLock(async () => {
      // 网络请求期间不持 plugin storage 锁；获得锁后必须重读，避免覆盖并发 marketplace 更新。
      const latest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
      if (!latest) return;
      const enriched = applyClaudePluginIcons(latest.raw, iconSources);
      if (enriched === latest.raw) return;
      // Bugfix：升级前已有 lastUpdated 的 catalog 不会触发 UI 自动刷新，导致新图标功能永远不可见。
      // 这里只回写展示增强字段，不重拉 marketplace，也不改变更新检测时间。
      await writeMarketplaceManifest(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE, enriched);
    });
  } catch {
    // 存量图标迁移是 best-effort；失败不能让 plugins/overview 不可用，下次 Agent 启动可重试。
  }
}
