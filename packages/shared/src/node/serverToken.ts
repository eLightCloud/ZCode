import { createHash, timingSafeEqual } from "node:crypto";

/** Compare an opaque instance credential; this does not establish enterprise authorization. */
export function matchesServerToken(
  candidate: string | undefined | null,
  expected: string,
): boolean {
  if (!expected) return false;
  return matchesServerTokenHash(candidate, createHash("sha256").update(expected).digest("hex"));
}

export function matchesServerTokenHash(
  candidate: string | undefined | null,
  digest: string,
): boolean {
  if (!candidate || !/^[a-f0-9]{64}$/i.test(digest)) return false;
  const supplied = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(supplied, Buffer.from(digest, "hex"));
}
