import { expect, it, vi } from "vitest";
import { createWorkspaceEntryServices, openApplicationConversation } from "./contract.js";
it("does not discover or provision a host and rejects execution writes", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const services = createWorkspaceEntryServices("zh-CN");
  expect((await services.settingService.get()).locale).toBe("zh-CN");
  expect(await services.zcodeTaskService.listTasks({ workspacePath: "" })).toEqual([]);
  await expect(services.fileService.ensureConversationWorkspace()).rejects.toThrow("not available");
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

it("does not transfer a draft across a changed identity", async () => {
  const pushState = vi.fn(),
    reload = vi.fn();
  vi.stubGlobal("window", { history: { pushState }, location: { reload, assign: vi.fn() } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ tenant: "other", subject: "person" }) })),
  );
  await expect(
    openApplicationConversation({
      session: "s",
      instanceId: "host",
      scope: "original:person",
      draft: "synthetic draft",
    }),
  ).rejects.toThrow("scope_changed");
  expect(pushState).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it("keeps a same-person navigation draft out of the URL and accepted input", async () => {
  const pushState = vi.fn(),
    reload = vi.fn();
  vi.stubGlobal("window", { history: { pushState }, location: { reload, assign: vi.fn() } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ tenant: "original", subject: "person" }),
    })),
  );
  await openApplicationConversation({
    session: "s",
    instanceId: "host",
    scope: "original:person",
    draft: "synthetic draft",
  });
  expect(pushState).toHaveBeenCalledWith(
    expect.objectContaining({
      zcodeConversationDraft: expect.objectContaining({ draft: "synthetic draft" }),
    }),
    "",
    "/workspace?instance_id=host&conversation=s",
  );
  expect(reload).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
