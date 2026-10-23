import { readFileSync } from "node:fs";

import { recoverAtomicTargetSync, writeFileAtomically } from "./atomic-directory.js";

export function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}
