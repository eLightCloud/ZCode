// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/** Trusted display identity only; never an execution or agent identifier. */
export function resolveContextProductName(productName?: string): string {
  if (productName === undefined) return "ZCode";
  const name = productName.trim();
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}<>]/u.test(name)) {
    throw new Error("Invalid application product name");
  }
  return name;
}

export function buildCliPrefixSection(productName?: string): ContextSection {
  const content = `You are ${resolveContextProductName(productName)}, an interactive coding agent`;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
