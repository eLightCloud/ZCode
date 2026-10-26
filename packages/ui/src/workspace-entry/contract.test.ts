// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceEntryContent } from "./contract.js";
import type { RootProps } from "@/root/types.js";
const state = vi.hoisted(() => ({ received: vi.fn(), register: vi.fn() }));
vi.mock("@/App.js", () => ({
  App: (props: any) => {
    state.received(props);
    return createElement(
      "div",
      null,
      props.workspaceEntryContent,
      createElement("button", { onClick: () => props.onCreateTask() }, "New native work"),
    );
  },
}));
vi.mock("@/root/RootShell.js", () => ({ RootShell: ({ children }: any) => children }));
vi.mock("@/root/WorkspaceSettingsLayer.js", () => ({ WorkspaceSettingsLayer: () => null }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({}),
  useTabStore: () => false,
}));
vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  registerBaseWorkspaceServices: state.register,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("renders the native shell with no workspace and prepares only on explicit action", () => {
  const onPrepare = vi.fn();
  const props = {
    services: { feedbackService: {} },
    workspaceEntry: { content: "Ready to work", onPrepare },
  } as unknown as RootProps;
  const view = render(createElement(WorkspaceEntryContent, { props }));
  expect(screen.getByText("Ready to work")).toBeTruthy();
  expect(state.received.mock.lastCall?.[0].workspaceAbsPath).toBe("");
  expect(onPrepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("New native work"));
  expect(onPrepare).toHaveBeenCalledOnce();
  view.rerender(
    createElement(WorkspaceEntryContent, {
      props: { ...props, workspaceEntry: { ...props.workspaceEntry!, pending: true } },
    }),
  );
  fireEvent.click(screen.getByText("New native work"));
  expect(onPrepare).toHaveBeenCalledOnce();
});
