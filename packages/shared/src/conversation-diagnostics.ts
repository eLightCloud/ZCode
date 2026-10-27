import { z } from "zod";

/** Bounded native diagnostic codes; never exception text or resource identifiers. */
export const conversationObservationReasonSchema = z.enum([
  "none",
  "checkpoint_limit",
  "transport_limit",
  "subject_capacity",
  "version_limit",
  "integrity",
  "scope",
  "schema",
  "storage",
  "invalid",
  "blocked",
  "stale",
  "not_found",
  "unavailable",
  "changed",
  "forward_only",
  "conflict",
  "busy",
  "capability",
  "required_skill",
  "model",
  "files",
  "cancelling",
]);
