export const desktopApplicationHttpModule = {
  id: "desktop-application-http",
  requires: ["shared", "application-http-protocol"],
  provides: ["application-http-main"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
