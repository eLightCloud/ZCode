import { z } from "zod";
import { conversationArtifactUriSchema } from "@zcode/shared";
import {
  conversationInputIntentSchema,
  type ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";

/** The existing native intent schema owns the DTO. This codec only limits portability. */
function portableIntent(allowFiles: boolean) {
  return z.custom<ConversationInputIntent>((value) => {
    const parsed = conversationInputIntentSchema.safeParse(value);
    if (!parsed.success) return false;
    const intent = parsed.data;
    return (
      intent.kind === "sendText" &&
      (allowFiles
        ? intent.attachments.every((ref) => portableAttachmentRef.safeParse(ref).success)
        : intent.attachments.length === 0) &&
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
}
export const portableAttachmentRef = z
  .object({
    ref: z.string().refine((value) => conversationArtifactUriSchema.safeParse(value).success),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/]/.test(value)),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    previewRef: z
      .string()
      .refine((value) => conversationArtifactUriSchema.safeParse(value).success)
      .optional(),
  })
  .strict();
export const portableTextIntent = portableIntent(false);
export const portableFileIntent = portableIntent(true);
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
function metadata(allowFiles: boolean) {
  return z
    .object({
      conversationInputIntent: allowFiles ? portableFileIntent : portableTextIntent,
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
}
export const portableTextMetadata = metadata(false);
export const portableFileMetadata = metadata(true);
function payload(allowFiles: boolean) {
  return z
    .object({
      text: z.string(),
      conversationInputIntent: z
        .union([
          allowFiles ? portableFileIntent : portableTextIntent,
          z.object({ sourceCommandId: z.string().min(1) }).strict(),
        ])
        .optional(),
      intent: z.record(z.unknown()).optional(),
      attachments: (allowFiles ? z.array(portableAttachmentRef) : z.array(z.never())).optional(),
      sourceCommandType: z.enum(["createSession", "sendText"]).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const intent = value.conversationInputIntent;
      const issue = () =>
        context.addIssue({ code: "custom", message: "Inconsistent native input payload" });
      if (intent && "queueItemId" in intent) {
        if (
          intent.text !== value.text ||
          (value.intent && !legacyAgrees(intent, value.intent)) ||
          (value.attachments !== undefined && !equal(value.attachments, intent.attachments))
        )
          issue();
      } else if (value.intent || value.attachments || value.sourceCommandType) issue();
    });
}
export const portableTextPayload = payload(false);
export const portableFilePayload = payload(true);
