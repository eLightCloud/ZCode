import { textCheckpointSchema } from "@zcode/contracts";
import type { Logger, SyncVersion } from "@zcode/contracts";
export const events: unknown[] = [];
export const logger: Logger = {
  info: (_message, context) => {
    events.push(context);
  },
  warn: (_message, context) => {
    events.push(context);
  },
  error: (_message, context) => {
    events.push(context);
  },
  debug: () => {},
  child: (context) => ({
    ...logger,
    info: (_message, values) => {
      events.push({ ...context, ...values });
    },
    warn: (_message, values) => {
      events.push({ ...context, ...values });
    },
  }),
};
export function checkpoint(session = "session-sync") {
  return textCheckpointSchema.parse({
    format: "zcode.text-checkpoint",
    version: 1,
    session: {
      id: session,
      slug: "sync",
      title: "Synthetic sync fixture",
      version: "1",
      time: { created: 1, updated: 2 },
    },
    modelSelection: { providerId: "synthetic", modelId: "model" },
    modelSelectionEntryId: "selection-entry",
    messages: [
      {
        info: { id: "user-1", role: "user", agent: "build", time: { created: 1 } },
        parts: [{ id: "part-user", type: "text", text: "SYNTHETIC_PRIVATE_PROMPT" }],
      },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          parentID: "user-1",
          agent: "build",
          mode: "build",
          time: { created: 1, completed: 2 },
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: "part-assistant", type: "text", text: "Synthetic saved reply" }],
      },
    ],
    inputs: [],
  });
}
export function version(
  id: string,
  parent: string | null = null,
  location = "desktop",
  generation = 0,
): SyncVersion {
  return { id, parent, location, generation, checkpoint: checkpoint() };
}
