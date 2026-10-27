// @vitest-environment jsdom
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

it("redirects legacy feedback commands without forwarding automatic material", async () => {
  const { createElement } = await import("react");
  const { render, cleanup, act } = await import("@testing-library/react");
  const { ApplicationPeripheralsProvider } = await import("../src/root/ApplicationPeripherals.js");
  const { useFeedbackStore } = await import("../src/feedback/feedbackStore.js");
  const { vi } = await import("vitest");
  useFeedbackStore.getState().close();
  const openFeedback = vi.fn();
  const value = {
    nativeCloudEnabled: false,
    openHelp: vi.fn(),
    openFeedback,
    openShare: vi.fn(),
    renderModelPlans: () => null,
  };
  const view = render(
    createElement(ApplicationPeripheralsProvider, { value, children: createElement("div") }),
  );
  act(() => useFeedbackStore.getState().openSubmit({ title: "private-draft", includeLogs: true }));
  expect(openFeedback.mock.calls).toEqual([[]]);
  expect(useFeedbackStore.getState().submitDraft).toBeNull();
  act(() => useFeedbackStore.getState().openFeatureRequest());
  act(() => useFeedbackStore.getState().openTickets());
  expect(openFeedback).toHaveBeenCalledTimes(3);
  view.unmount();
  act(() => useFeedbackStore.getState().openSubmit());
  expect(useFeedbackStore.getState().open).toBe(true);
  useFeedbackStore.getState().close();
  cleanup();
});

it("returns focus to the application trigger after a controlled dialog closes", async () => {
  const { createElement, useState } = await import("react");
  const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
  const { ApplicationDialog } = await import("../src/root/ApplicationDialog.js");
  const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
  function Probe() {
    const [open, setOpen] = useState(false);
    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          onClick: (event) => {
            event.currentTarget.focus();
            setOpen(true);
          },
        },
        "feedback trigger",
      ),
      createElement(ApplicationDialog, {
        title: "feedback",
        open,
        onClose: () => setOpen(false),
        children: createElement("button", { onClick: () => setOpen(false) }, "close feedback"),
      }),
    );
  }
  const view = render(createElement(ZCodeIntlProvider, { children: createElement(Probe) }));
  const trigger = view.getByRole("button", { name: "feedback trigger" });
  fireEvent.click(trigger);
  await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "close feedback" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  cleanup();
});
