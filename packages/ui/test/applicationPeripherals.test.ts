import { describe, expect, it } from "vitest";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { applicationShareCandidate } from "../src/root/ApplicationPeripherals.js";
import { resolveBuiltinPluginMarketplaceId } from "@zcode/shared";

const base = { rowId: 1, turnId: "turn-1", createdAt: 1, createdAtSeq: 1 };

describe("application-owned peripherals", () => {
  it("exports visible messages only; reasoning, tool output and incomplete answers never become candidates", () => {
    const rows = [
      conversationRowSchema.parse({
        ...base,
        kind: "assistantText",
        text: "visible",
        state: "complete",
      }),
      conversationRowSchema.parse({
        ...base,
        rowId: 2,
        kind: "reasoning",
        text: "private",
        state: "complete",
      }),
      conversationRowSchema.parse({
        ...base,
        rowId: 3,
        kind: "assistantText",
        text: "unfinished",
        state: "streaming",
      }),
    ];
    expect(applicationShareCandidate("title", rows)).toEqual({
      title: "title",
      messages: [{ role: "assistant", content: "visible" }],
    });
  });
  it("keeps upstream identity by default and rejects untrusted distribution identifiers", () => {
    expect(resolveBuiltinPluginMarketplaceId()).toBe("zcode-plugins-official");
    expect(resolveBuiltinPluginMarketplaceId("application-native")).toBe("application-native");
    expect(() => resolveBuiltinPluginMarketplaceId("../other")).toThrow();
  });
});

it("provides a disabled cloud context without loading account inventory or opening a purchase surface", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CodingPlanUpgradeDialogProvider, useCodingPlanUpgradeDialog } =
    await import("../src/settings/CodingPlanUpgradeDialogProvider.js");
  function Probe() {
    const context = useCodingPlanUpgradeDialog();
    return createElement(
      "p",
      null,
      context.inventory.entryPlanList === "" ? "no cloud products" : "unexpected products",
    );
  }
  const html = renderToStaticMarkup(
    createElement(CodingPlanUpgradeDialogProvider, {
      enabled: false,
      children: createElement(Probe),
    }),
  );
  expect(html).toContain("no cloud products");
});
