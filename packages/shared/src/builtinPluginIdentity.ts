/** Build/distribution identity; has no account or resource-authorization semantics. */
declare const __ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID__: string;

export function resolveBuiltinPluginMarketplaceId(value?: string): string {
  if (value === undefined || value === "") return "zcode-plugins-official";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error("application.builtin-marketplace.invalid");
  return value;
}

export const BUNDLED_PLUGIN_MARKETPLACE_ID = resolveBuiltinPluginMarketplaceId(
  typeof __ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID__ !== "undefined"
    ? __ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID__
    : typeof process !== "undefined"
      ? process.env["ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID"]
      : undefined,
);

/** Read old user choices only while an application rebinds its bundled assets. New writes use the first key. */
export function builtinPluginStateIds(id: string): readonly string[] {
  const original = "@zcode-plugins-official";
  const target = "@" + BUNDLED_PLUGIN_MARKETPLACE_ID;
  if (target === original) return [id];
  if (id.endsWith(target)) return [id, id.slice(0, -target.length) + original];
  if (id.endsWith(original)) return [id.slice(0, -original.length) + target, id];
  return [id];
}
