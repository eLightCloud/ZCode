export const platformBrowserModule = {
  id: "platform-browser-protocol",
  requires: ["shared"],
  provides: ["platform-browser-protocol"],
  publicEntrypoints: ["contract.ts"],
} as const;
