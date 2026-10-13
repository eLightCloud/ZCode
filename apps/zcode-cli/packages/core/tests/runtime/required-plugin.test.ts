import { describe, expect, it, vi } from "vitest";
import {
  enforceRequiredPluginEntry,
  requiredPluginSelection,
} from "../../src/runtime/methods/required-plugin.js";

describe("required plugin entry", () => {
  it("uses canonical destinations and rejects ambiguous or invalid selections", () => {
    expect(requiredPluginSelection("[@Report](required-plugin://report@company)")).toBe(
      "report@company",
    );
    expect(requiredPluginSelection("[work](required-plugin://none)")).toBeNull();
    expect(requiredPluginSelection("required-plugin://report@company")).toBeUndefined();
    expect(() => requiredPluginSelection("[x](required-plugin://../secret)")).toThrow();
    expect(() =>
      requiredPluginSelection("[a](required-plugin://a@x) [b](required-plugin://b@x)"),
    ).toThrow();
  });

  function fixture(load = vi.fn()) {
    const entries: any[] = [];
    const persisted = vi.fn();
    const runtime = {
      workingDirectory: "/fixture",
      sessionId: "fixture-session",
      skillPort: { loadRequiredPluginSkill: load },
      messageHistory: {
        borrowReadOnlyRuntimeEntries: () => entries,
        addAttachment: (source: string, content: string) =>
          entries.push({
            kind: "attachment",
            metadata: { source },
            content,
          }),
      },
      persistSyntheticUserNoticeForSession: persisted,
    };
    return { runtime, entries, persisted };
  }

  it("does not write a fallback when the required loader rejects", async () => {
    const state = fixture(
      vi.fn().mockRejectedValue(new Error("required_skill.plugin_unavailable")),
    );
    await expect(
      enforceRequiredPluginEntry(
        state.runtime as never,
        "[report](required-plugin://report@company)",
        {} as never,
      ),
    ).rejects.toThrow("unavailable");
    expect(state.persisted).not.toHaveBeenCalled();
    expect(state.entries).toHaveLength(0);
  });

  it("reloads after cold hydration and permits an explicit return to ordinary work", async () => {
    const load = vi
      .fn()
      .mockResolvedValue({
        metadata: { name: "daily" },
        content: "Use the business method",
        baseDirectory: "/plugin",
        truncated: false,
      });
    const state = fixture(load);
    await enforceRequiredPluginEntry(
      state.runtime as never,
      "[report](required-plugin://report@company)",
      {} as never,
    );
    expect(state.entries[0].content).toContain("Use the business method");
    const resumed = fixture(load);
    resumed.entries.push(...JSON.parse(JSON.stringify(state.entries)));
    await enforceRequiredPluginEntry(resumed.runtime as never, "continue", {} as never);
    expect(load).toHaveBeenCalledTimes(2);
    await enforceRequiredPluginEntry(
      resumed.runtime as never,
      "[ordinary](required-plugin://none)",
      {} as never,
    );
    await enforceRequiredPluginEntry(resumed.runtime as never, "new work", {} as never);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
