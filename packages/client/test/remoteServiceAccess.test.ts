import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { ISourceServerManagementService } from "@zcode/services";
import { createMessagePortServiceConnection } from "../src/messageport.js";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

describe("RemoteServiceAccess", () => {
  it("公开配置经独立频道 RPC 读取", async () => {
    const call = vi.fn(async () => ({ pluginStoreOrder: null }));
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.clientConfigService.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
    });
    expect(requested).toContain("client-config");
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getSnapshot", [{ forceRefresh: true }]]);
  });
});

describe("RemoteServiceAccess optional channels", () => {
  it("only exposes the window controller on a desktop workspace port", () => {
    const { port1, port2 } = new MessageChannel();
    const workspace = createMessagePortServiceConnection(port1, { windowControllerService: true });
    const settings = createMessagePortServiceConnection(port2);
    try {
      expect(workspace.services.windowControllerService).toBeDefined();
      expect(settings.services.windowControllerService === undefined).toBe(true);
    } finally {
      workspace.dispose();
      settings.dispose();
    }
  });

  it("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });
});

it("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});
