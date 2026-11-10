// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCreatedTaskGroupPlacement } from "@/project-sidebar/useCreatedTaskGroupPlacement.js";
import { ToastMessageView, type ToastOptions } from "@/components/ui/toast.js";
import type { GroupTaskRef, ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  directory: null as { groups: { refresh: () => Promise<void> } } | null,
  admit: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  dismiss: vi.fn(),
  intl: { formatMessage: ({ id }: { id: string }) => id },
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => mocks.directory,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ intl: mocks.intl }) }));
vi.mock("@/components/ui/toast.js", async (original) => ({
  ...(await original<typeof import("@/components/ui/toast.js")>()),
  toast: (...args: unknown[]) => mocks.toast(...args),
  dismissToast: (...args: unknown[]) => mocks.dismiss(...args),
}));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const target = { taskId: "created", workspacePath: "/same" };
const server: GroupTaskRef = { ...target, hostId: "remote:server:source" };
const tree = (refs: GroupTaskRef[]): ProjectTree => ({
  projects: [],
  tasks: refs.map((ref) => ({ ...ref, projectId: "p", archived: false }) as ProjectTask),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admit.mockReset().mockResolvedValue(undefined);
  mocks.read.mockReset().mockResolvedValue(tree([server]));
  mocks.refresh.mockResolvedValue(undefined);
  mocks.toast.mockReturnValue(17);
  mocks.directory = { groups: { refresh: mocks.refresh } };
  mocks.services = {
    taskGroupService: { admit: mocks.admit },
    projectService: { readTree: mocks.read },
  };
});
afterEach(cleanup);

it.each([
  { ...target, hostId: "local" },
  server,
  { ...server, workspaceIdentity: "remote:server:source:/same" },
])("GRP12：使用目录确认的引用 $hostId/$workspaceIdentity，不额外读取", async (ref) => {
  const { result } = renderHook(useCreatedTaskGroupPlacement);
  const organize = result.current(ref, "group-original", "command-original")!;
  await act(async () => {
    await organize(ref);
  });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.admit).toHaveBeenCalledExactlyOnceWith({
    tasks: [ref],
    placement: { task: ref, groupId: "group-original", creationId: "command-original" },
  });
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("GRP12：嵌入 pane 从公开目录取得 path-only Server owner，无 placement 时不读取", async () => {
  mocks.directory = null;
  const { result } = renderHook(useCreatedTaskGroupPlacement);
  expect(result.current(target, undefined, "unused")).toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
  await act(async () => {
    await result.current(target, null, "command")!();
  });
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
    includeDeleted: true,
    includeDeletedTasks: true,
  });
  expect(mocks.admit).toHaveBeenCalledWith({
    tasks: [server],
    placement: { task: server, groupId: null, creationId: "command" },
  });
});

it.each([
  { refs: [] },
  { refs: [{ ...server, workspaceIdentity: "remote:server:other:/same" }] },
  { refs: [{ ...server, workspacePath: "/different" }] },
  { refs: [server, { ...server, hostId: "remote:server:other" }] },
])("GRP12：缺失、错误身份/路径或歧义引用不能猜 Host", async ({ refs }) => {
  mocks.directory = null;
  mocks.read.mockResolvedValue(tree(refs));
  const { result } = renderHook(useCreatedTaskGroupPlacement);
  await act(async () => {
    await result.current(target, "group", "command")!();
  });
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    "taskGroup.placementFailed",
    expect.objectContaining({ variant: "warning", onAction: expect.any(Function) }),
  );
});

it("GRP12：可见重试冻结原地址、组和 creationId，连点只发送一次归组", async () => {
  mocks.admit.mockRejectedValueOnce(new Error("project.host-offline"));
  const { result, rerender } = renderHook(useCreatedTaskGroupPlacement);
  const address = { ...target };
  const organize = result.current(address, "original", "original-command")!;
  await act(async () => {
    await organize(server);
  });
  address.workspacePath = "/new-project";
  mocks.read.mockResolvedValue(tree([{ ...server, workspacePath: "/new-project" }]));
  rerender();
  const [message, options] = mocks.toast.mock.calls[0] as [string, ToastOptions];
  let release!: () => void;
  mocks.admit.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  render(
    createElement(ToastMessageView, {
      item: { id: 17, message, durationMs: 0, ...options },
      visible: true,
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "taskGroup.retryPlacement" }));
    fireEvent.click(screen.getByRole("button", { name: "taskGroup.retryPlacement" }));
  });
  expect(mocks.admit).toHaveBeenCalledTimes(2);
  expect(mocks.admit.mock.calls[1][0]).toEqual(mocks.admit.mock.calls[0][0]);
  expect(mocks.read).not.toHaveBeenCalled();
  await act(async () => {
    release();
  });
  expect(mocks.dismiss).toHaveBeenCalledWith(17);
});
