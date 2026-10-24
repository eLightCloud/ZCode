import { basename, join } from "node:path";
export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}
