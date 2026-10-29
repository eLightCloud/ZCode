import { expect, it } from "vitest";
import { textCheckpointSchema } from "@zcode/contracts";
import { checkpoint } from "../checks/sync-fixture.mjs";

function actualInput() {
  const value = checkpoint("input-v4");
  const full = {
    sourceCommandId: "command",
    queueItemId: "queue_command",
    clientId: "client",
    kind: "sendText",
    text: "SYNTHETIC_PRIVATE_PROMPT",
    attachments: [],
    modelSelection: value.modelSelection,
    mode: "build",
    planEnabled: false,
    delivery: { requested: "startNow", admitted: "startNow" },
    order: { admissionSeq: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: "drained" },
    admittedAt: 1,
  };
  return {
    ...value,
    version: 2,
    messages: value.messages.map((message, index) =>
      index
        ? message
        : {
            ...message,
            info: {
              ...message.info,
              anchor: { sourceCommandId: "command" },
              metadata: {
                conversationInputIntent: full,
                inputClientId: "client",
                inputIntent: {
                  sourceCommandId: "command",
                  queueItemId: "queue_command",
                  clientId: "client",
                  kind: "sendText",
                  text: "SYNTHETIC_PRIVATE_PROMPT",
                  modelSelection: value.modelSelection,
                  mode: "build",
                  planEnabled: false,
                  requestedDelivery: "startNow",
                  admittedDelivery: "startNow",
                  admissionSeq: 1,
                  admittedAt: 1,
                },
              },
            },
          },
    ),
  };
}
it("preserves actual canonical V4 input and its exact legacy projection in text format v2", () => {
  const value = actualInput();
  expect(textCheckpointSchema.parse(value)).toEqual(value);
  expect(textCheckpointSchema.safeParse({ ...value, version: 1 }).success).toBe(false);
});
it.each(["edit", "plan", "yolo"])("preserves settled native %s submission history", (mode) => {
  const value = actualInput();
  const user = value.messages[0]!.info;
  if (user.role !== "user" || !user.metadata || !("conversationInputIntent" in user.metadata))
    throw new Error("synthetic_input_missing");
  user.metadata.conversationInputIntent.mode = mode;
  user.metadata.inputIntent.mode = mode;
  expect(textCheckpointSchema.parse(value)).toEqual(value);
  user.metadata.conversationInputIntent.mode = "unknown";
  expect(textCheckpointSchema.safeParse(value).success).toBe(false);
});
it.each([
  "unknown",
  "wrong_client",
  "wrong_text",
  "attachment",
  "bot",
  "legacy_conflict",
  "legacy_array_shape",
])("blocks %s rather than dropping necessary input state", (kind) => {
  const value = actualInput();
  const user = value.messages[0]!.info as unknown as {
    metadata: {
      hiddenNecessaryFact?: boolean;
      inputClientId: string;
      conversationInputIntent: Record<string, unknown>;
      inputIntent: Record<string, unknown>;
    };
  };
  if (kind === "unknown") user.metadata.hiddenNecessaryFact = true;
  if (kind === "wrong_client") user.metadata.inputClientId = "other";
  if (kind === "wrong_text") user.metadata.conversationInputIntent.text = "different";
  if (kind === "attachment")
    user.metadata.conversationInputIntent.attachments = [
      { ref: "attachment", fileName: "file", mime: "text/plain", bytes: 1 },
    ];
  if (kind === "bot") user.metadata.conversationInputIntent.botGroupSource = {};
  if (kind === "legacy_conflict") user.metadata.inputIntent.clientId = "other";
  if (kind === "legacy_array_shape") user.metadata.inputIntent.attachmentRefs = {};
  expect(textCheckpointSchema.safeParse(value).success).toBe(false);
});
