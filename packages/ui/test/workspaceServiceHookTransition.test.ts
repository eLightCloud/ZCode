// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { useZCodeAgentService } from "../src/hooks/useZCodeAgentService.js";
import { useZCodeSessionService } from "../src/hooks/useZCodeSessionService.js";
import { useZCodeTaskService } from "../src/hooks/useZCodeTaskService.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "../src/store/remoteWorkspaceSessionStore.js";

afterEach(() => { cleanup(); useRemoteWorkspaceSessionStore.setState({ baseServices: null,
  sessionsById: {}, sessionIdByWorkspacePath: {}, sessionIdByWorkspaceIdentity: {} }); });

it.each([false, true])("keeps service hook order across restored workspace paths with tabs=%s", (tabs) => {
  const context = { zcodeAgentService: { source: "context" }, zcodeSessionService: { source: "context" },
    zcodeTaskService: { source: "context" } } as unknown as IServiceAccessor;
  const base = { zcodeAgentService: { source: "base" }, zcodeSessionService: { source: "base" },
    zcodeTaskService: { source: "base" } } as unknown as IServiceAccessor;
  useRemoteWorkspaceSessionStore.setState({ baseServices: base });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(ServiceProvider, { services: context,
    children: tabs ? createElement(TabStoreProvider, { children }) : children });
  const view = renderHook(({ path, identity }: { path?: string; identity?: string }) => ({
    agent: useZCodeAgentService(path, undefined, identity),
    session: useZCodeSessionService(path, undefined, identity),
    task: useZCodeTaskService(path, undefined, identity),
  }), { wrapper, initialProps: {} });
  expect(view.result.current.agent).toBe(context.zcodeAgentService);
  expect(view.result.current.session).toBe(context.zcodeSessionService);
  view.rerender({ path: "/restored" });
  expect(view.result.current.agent).toBe(base.zcodeAgentService);
  expect(view.result.current.session).toBe(base.zcodeSessionService);
  expect((view.result.current.task as unknown as { source: string }).source).toBe("base");
  // 未恢复的远端仍应断连，不能因 hook 归一化而借用本机服务。
  view.rerender({ path: "/restored", identity: "ssh:unavailable" });
  expect(view.result.current.agent).not.toBe(base.zcodeAgentService);
  expect(view.result.current.session).not.toBe(base.zcodeSessionService);
  view.rerender({ path: undefined });
  expect(view.result.current.agent).toBe(context.zcodeAgentService);
  expect(view.result.current.session).toBe(context.zcodeSessionService);
  expect((view.result.current.task as unknown as { source: string }).source).toBe("context");
});
