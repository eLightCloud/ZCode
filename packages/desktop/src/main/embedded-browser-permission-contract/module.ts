/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "embedded-browser-permission",
  requires: ["desktop", "shared", "ui"],
  provides: ["embedded-browser-permission"],
  publicEntrypoints: [
    "packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts",
    "packages/desktop/src/main/embedded-browser-permission-contract/contract.ts",
    "packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts",
    "packages/desktop/src/main/embeddedBrowserSitePermissionStore.ts",
    "packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx",
  ],
} as const;
