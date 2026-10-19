// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  ApplicationPluginLocationEffect,
  ApplicationPluginStoreProvider,
} from "@/root/ApplicationPluginStoreSection.js";

vi.mock("@/root/ApplicationPages.js", () => ({
  ApplicationPageContent: ({ render: renderEffect }: { render: (context: unknown) => unknown }) =>
    renderEffect({
      workspace: {
        workspaceIdentity: "remote:one",
        workspacePath: "/same-path",
        remoteSessionId: "remote-one",
      },
      rpcReady: false,
    }),
}));
afterEach(cleanup);

it("does not mount a background effect without trusted assembly", () => {
  expect(render(createElement(ApplicationPluginLocationEffect)).container.textContent).toBe("");
});
it("mounts outside marketplace navigation through the existing workspace resolver", () => {
  const effect = vi.fn(() => null);
  render(
    createElement(ApplicationPluginStoreProvider, {
      section: {
        label: "Application",
        marketplaceIds: [],
        onRefresh: vi.fn(),
        render: () => null,
        renderLocationEffect: effect,
      },
      children: createElement(ApplicationPluginLocationEffect),
    }),
  );
  expect(effect).toHaveBeenCalledWith({
    workspace: {
      workspaceIdentity: "remote:one",
      workspacePath: "/same-path",
      remoteSessionId: "remote-one",
    },
    rpcReady: false,
  });
});
