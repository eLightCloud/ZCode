// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { IProjectService } from "@/project-sidebar/contract.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => null }));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => null,
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn() }));
vi.mock("@/RemoteConnectionDialogContent.js", () => ({
  useRemoteBoundaryAcknowledgement: () => async () => true,
}));
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

it.each(["local", "remote:server:other"])(
  "browses and saves on the service owner or explicitly selected device: %s",
  async (deviceId) => {
    const owner = deviceId === "local" ? "remote:server:web-owner" : deviceId;
    const expectedHostId = deviceId === "local" ? undefined : deviceId;
    const saved = { id: "created", hostId: owner, name: "Created", roots: [] };
    const readDirectory = vi.fn<IProjectService["readDirectory"]>(async (input = {}) => {
      if (input.hostId !== undefined && input.hostId !== owner)
        throw new Error("project.host-offline");
      return {
        path: input.path ?? "/home/owner",
        entries:
          input.path === "/home/owner/repo"
            ? []
            : [{ name: "repo", path: "/home/owner/repo", type: "directory" }],
      };
    });
    const saveProject = vi.fn(async (input: { hostId?: string }) => {
      if (input.hostId !== undefined && input.hostId !== owner)
        throw new Error("project.host-offline");
      return saved;
    });
    const onSaved = vi.fn(async () => {});
    render(
      createElement(ProjectEditor, {
        project: null,
        projects: [],
        devices: [{ id: deviceId, label: "Device", status: "online" }],
        defaultDeviceId: deviceId,
        service: { readDirectory, saveProject, readTree: async () => ({ projects: [] }) } as never,
        onClose: vi.fn(),
        onSaved,
      }),
    );
    fireEvent.click(screen.getByTestId("virtual-project-browse"));
    fireEvent.click(await screen.findByRole("button", { name: "repo" }));
    await waitFor(() => expect(screen.getByDisplayValue("/home/owner/repo")).toBeTruthy());
    fireEvent.click(screen.getByTestId("directory-browser-confirm"));
    fireEvent.click(screen.getByTestId("virtual-project-save"));
    fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(readDirectory).toHaveBeenCalledWith({ hostId: expectedHostId });
    expect(readDirectory).toHaveBeenCalledWith({
      hostId: expectedHostId,
      path: "/home/owner/repo",
    });
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        roots: ["/home/owner/repo"],
        primaryRoot: "/home/owner/repo",
      }),
    );
    if (deviceId === "local") expect(saveProject.mock.calls[0]?.[0]).not.toHaveProperty("hostId");
    else expect(saveProject.mock.calls[0]?.[0].hostId).toBe(deviceId);
  },
);
