import { z } from "zod";
import {
  conversationInputIntentSchema,
  type ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";

/** The existing native intent schema owns the DTO. This codec only limits portability. */
export const portableTextIntent = z.custom<ConversationInputIntent>((value) => {
  const parsed = conversationInputIntentSchema.safeParse(value);
  if (!parsed.success) return false;
  const intent = parsed.data;
  return (
    intent.kind === "sendText" &&
    intent.attachments.length === 0 &&
    (!intent.mode || ["build", "guarded"].includes(intent.mode)) &&
    intent.planEnabled !== true &&
    intent.delivery.admitted !== "guide" &&
    intent.steer.state === "notRequested" &&
    ["admitted", "queued", "drained"].includes(intent.dispatch.state) &&
    [
      "botGroupSource",
      "conversationQuotes",
      "sharedContextRefs",
      "highspeed",
      "provenance",
      "source",
    ].every((key) => (value as Record<string, unknown>)[key] === undefined)
  );
});
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a).sort(),
    right = Object.keys(b).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, index) =>
        key === right[index] &&
        equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
function legacyAgrees(intent: ConversationInputIntent, value: Record<string, unknown>) {
  const expected: Record<string, unknown> = {
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    text: intent.text,
    modelSelection: intent.modelSelection,
    mode: intent.mode,
    planEnabled: intent.planEnabled,
    inputOrigin: intent.inputOrigin,
    admissionSeq: intent.order.admissionSeq,
    queuePosition: intent.order.queuePosition,
    admittedAt: intent.admittedAt,
    requestedDelivery: intent.delivery.requested,
    admittedDelivery: intent.delivery.admitted,
    attachmentRefs: intent.attachments,
  };
  const required = [
    "sourceCommandId",
    "queueItemId",
    "clientId",
    "kind",
    "admissionSeq",
    "admittedAt",
    "requestedDelivery",
    "admittedDelivery",
  ];
  return (
    required.every((key) => key in value) &&
    Object.entries(value).every(
      ([key, field]) => Object.hasOwn(expected, key) && equal(field, expected[key]),
    )
  );
}
export const portableTextMetadata = z
  .object({
    conversationInputIntent: portableTextIntent,
    inputIntent: z.record(z.unknown()).optional(),
    inputClientId: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const intent = value.conversationInputIntent;
    const issue = () =>
      context.addIssue({ code: "custom", message: "Inconsistent native input facts" });
    if (
      intent.dispatch.state !== "drained" ||
      (value.inputClientId !== undefined && value.inputClientId !== intent.clientId)
    )
      issue();
    if (!value.inputIntent) return;
    if (!legacyAgrees(intent, value.inputIntent)) issue();
  });

export const portableTextPayload = z
  .object({
    text: z.string(),
    conversationInputIntent: z
      .union([portableTextIntent, z.object({ sourceCommandId: z.string().min(1) }).strict()])
      .optional(),
    intent: z.record(z.unknown()).optional(),
    attachments: z.array(z.never()).optional(),
    sourceCommandType: z.enum(["createSession", "sendText"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const intent = value.conversationInputIntent;
    const issue = () =>
      context.addIssue({ code: "custom", message: "Inconsistent native input payload" });
    if (intent && "queueItemId" in intent) {
      if (intent.text !== value.text || (value.intent && !legacyAgrees(intent, value.intent)))
        issue();
    } else if (value.intent || value.attachments || value.sourceCommandType) issue();
  });
