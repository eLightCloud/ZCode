import { describe, expect, it, vi } from "vitest";
import { createSessionId, type SkillPort } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const INPUT = "[@Daily](required-plugin://report@company) Prepare the daily report";

function fixture() {
  const requests: string[] = [];
  let enabled = true;
  const load = vi.fn(async () => {
    if (!enabled) throw new Error("required_skill.plugin_unavailable");
    return {
      metadata: { name: "daily", qualifiedName: "report:daily", pluginId: "report@company" },
      content: "SYNTHETIC_REQUIRED_METHOD: preserve source coverage and missing data",
      baseDirectory: "/synthetic/plugin/skills/daily",
      truncated: false,
    };
  });
  const runtime = createTestAgentRuntime(
    createSessionId("required-plugin-runtime"),
    { mode: "build" },
    {
      eventStore: createTestSessionEventStore(),
      skillPort: {
        discoverSkills: async () => ({ skills: [], diagnostics: [], totalDiscovered: 0 }),
        loadSkill: async () => {
          throw new Error("ordinary skill not selected");
        },
        loadRequiredPluginSkill: load,
      } as unknown as SkillPort,
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push(JSON.stringify(request.messages));
          return {
            finishReason: "stop",
            text: "controlled response",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          };
        },
      }),
    },
  );
  return {
    runtime,
    requests,
    load,
    disable: () => {
      enabled = false;
    },
  };
}

describe("required plugin through real runtime", () => {
  it("loads the required method before provider invocation and rechecks disablement on later turns", async () => {
    const state = fixture();
    await state.runtime.executeTurn(INPUT);
    expect(state.requests.some((text) => text.includes("SYNTHETIC_REQUIRED_METHOD"))).toBe(true);
    expect(state.load).toHaveBeenCalledTimes(1);
    const before = state.requests.length;
    state.disable();
    await expect(state.runtime.executeTurn("Continue the report")).rejects.toThrow("unavailable");
    expect(state.requests).toHaveLength(before);
    await state.runtime.executeTurn("[ordinary](required-plugin://none) Explain a general concept");
    expect(state.requests.length).toBeGreaterThan(before);
  });

  it("keeps a failed explicit selection constrained on retry instead of silently chatting", async () => {
    const state = fixture();
    state.disable();
    await expect(state.runtime.executeTurn(INPUT)).rejects.toThrow("unavailable");
    await expect(state.runtime.executeTurn("Retry")).rejects.toThrow("unavailable");
    expect(state.requests).toEqual([]);
  });

  it("does not treat model-only continuation text as a new entry selection", async () => {
    const state = fixture();
    await state.runtime.executeTurn("ordinary task");
    await state.runtime.executeTurn(INPUT, undefined, { inputVisibility: "model-only" });
    expect(state.load).not.toHaveBeenCalled();
  });
});
