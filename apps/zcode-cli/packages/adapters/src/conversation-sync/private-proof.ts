import { timingSafeEqual } from "node:crypto";
import type { NodeHttpIncomingRequest } from "../http/index.js";

export function privateProofMatcher(proof: string) {
  const secret = Buffer.from(proof);
  if (secret.length < 32 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(proof))
    throw new Error("Invalid private center trust configuration");
  return (request: NodeHttpIncomingRequest) => {
    const authorization = request.headers.authorization ?? "";
    const supplied = Buffer.from(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    return secret.length === supplied.length && timingSafeEqual(secret, supplied);
  };
}
