import { join } from "node:path";

export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";

export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

export const MARKETPLACE_FILE = "marketplace.json";

export const CLAUDE_OFFICIAL_MARKETPLACE = "claude-plugins-official";

export const PLUGIN_ICON_SOURCES_FILE = "icon-sources.json";

export const PLUGIN_ICON_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/";

export const PLUGIN_ICON_SOURCES_URL = `${PLUGIN_ICON_ASSETS_BASE_URL}${PLUGIN_ICON_SOURCES_FILE}`;

export const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;

export const MARKETPLACE_JSON_MAX_REDIRECTS = 5;

export const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;

export const claudeIconMigrationAttempts = new Set<string>();

export const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

export const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");

export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");

export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

export const DEFAULT_VERSION = "0.0.0";

export const GIT_CLONE_MAX_ATTEMPTS = 3;

export const GIT_COMMAND_TIMEOUT_MS = 90_000;

export const GIT_CLONE_RETRY_DELAY_MS = 1_000;

export const CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS = 30_000;

export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const UNSUPPORTED_MANIFEST_FIELDS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;
