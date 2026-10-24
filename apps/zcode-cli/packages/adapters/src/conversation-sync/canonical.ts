import { createHash } from "node:crypto";
import { ConversationSyncError } from "@zcode/contracts";
/** Stable code-unit ordering; never depends on an OS locale or ICU version. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new ConversationSyncError("invalid");
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  if (
    (typeof value === "number" && !Number.isFinite(value)) ||
    (!["string", "number", "boolean"].includes(typeof value) && value !== null)
  )
    throw new ConversationSyncError("invalid");
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
