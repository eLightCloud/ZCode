import { expect, it } from "vitest";
import { textCheckpointSchema } from "@zcode/contracts";
import { checkpointIndexProjection } from "../src/zcode-protocol/checkpoint-index.js";
function example() {
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  return textCheckpointSchema.parse({
    format: "zcode.text-checkpoint",
    version: 1,
    session: { id: "s", slug: "s", title: "", version: "1", time: { created: 1, updated: 2 } },
    modelSelection: { providerId: "synthetic", modelId: "model" },
    modelSelectionEntryId: "model-entry",
    messages: [
      {
        info: { id: "u", role: "user", agent: "build", time: { created: 1 } },
        parts: [{ id: "up", type: "text", text: "Original prompt" }],
      },
      {
        info: {
          id: "a",
          role: "assistant",
          parentID: "u",
          agent: "build",
          mode: "build",
          time: { created: 1, completed: 2 },
          finish: "stop",
          cost: 0,
          tokens,
        },
        parts: [{ id: "ap", type: "text", text: "Restored response" }],
      },
    ],
    inputs: [],
  });
}
it("derives cold native title, model and complete search from the same validated checkpoint", () => {
  const value = checkpointIndexProjection(example(), "/synthetic-target");
  expect(value?.meta).toMatchObject({
    taskId: "s",
    title: "Original prompt",
    status: "completed",
    mode: "build",
    createdAt: 1,
    updatedAt: 2,
  });
  expect(value?.meta.model).toContain("synthetic");
  expect(value?.searchableText).toBe("Original prompt\nRestored response");
  expect(JSON.stringify(value)).not.toContain("/synthetic-target");
});
it("does not invent a task mode for a portable older format with an unknown mode", () => {
  const value = example();
  const last = value.messages[1]!.info;
  if (last.role !== "assistant") throw new Error("fixture");
  last.mode = "future-unsupported";
  expect(checkpointIndexProjection(value, "/synthetic-target")).toBeUndefined();
  expect(textCheckpointSchema.safeParse(value).success).toBe(true);
});
it("search projection is bounded without shortening the source checkpoint", () => {
  const value = example();
  value.messages[0]!.parts[0] = { id: "up", type: "text", text: "x".repeat(210000) };
  expect(checkpointIndexProjection(value, "/synthetic-target")?.searchableText).toHaveLength(
    200000,
  );
  expect(value.messages[0]!.parts[0].text).toHaveLength(210000);
});
