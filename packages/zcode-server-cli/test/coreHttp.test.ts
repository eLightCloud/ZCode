import { afterEach } from "vitest";
import { describe } from "vitest";
import { expect } from "vitest";
import { it } from "vitest";
import { vi } from "vitest";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { IConversationShareService } from "@zcode/services";
import { IZCodeAgentService } from "@zcode/services";
import { IProviderProvisioningTargetService } from "@zcode/services";
import { ServiceCollection } from "@zcode/services";
import { readTrustedZCodeAgentV4Connection } from "@zcode/services";
import { serverRemoteAnonymousInfoSchema } from "@zcode/shared";
import { serverRemoteInfoSchema } from "@zcode/shared";
import type { ProviderProvisioningEnvelope } from "@zcode/shared";
import type { ProviderProvisioningResult } from "@zcode/shared";
import { createHostCapabilityStore } from "../src/server-core/hostCapability.js";
import { createCoreHttpServer } from "../src/server-core/http.js";
import { Emitter } from "@zcode/rpc";
import { VSBuffer } from "@zcode/rpc";
import { SocketProtocol } from "@zcode/rpc";
import { ChannelServer } from "@zcode/rpc";
import { ChannelClient } from "@zcode/rpc";
import { ProxyChannel } from "@zcode/rpc";
import type { ISocket } from "@zcode/rpc";
import { createTopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import { conversationShareConnectionScopeFactory } from "@zcode/services/node";
import { SourceServerWorkspaceIdentityMapper } from "@zcode/services/node";

async function connectResourcePeer(base: string, onValidate: (args: unknown) => void) {
  const response = await fetch(`${base}/api/rpc-host-capability`, {
    method: "POST",
    headers: { connection: "close" },
  });
  const { capability } = (await response.json()) as { capability: string };
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/host`, {
    headers: { "x-zcode-rpc-host-capability": capability },
  });
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  socket.on("message", (raw) =>
    data.fire(
      VSBuffer.wrap(
        Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
      ),
    ),
  );
  socket.on("close", () => close.fire());
  const transport: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (buffer) => {
      socket.send(buffer.buffer);
    },
    end: () => socket.close(),
    drain: async () => {},
    dispose: () => socket.close(),
  };
  // WebSocket 可在 open 同一轮分发初始化帧；连接内同步安装 RPC listener，不能先 await open。
  return new Promise<{ services: { zcodeAgentService: IZCodeAgentService }; dispose(): void }>(
    (resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        const protocol = new SocketProtocol(transport);
        const server = new ChannelServer(protocol, "test-desktop");
        server.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, {
          async call<T>(_context: string, command: string, args: unknown): Promise<T> {
            if (command !== "validate") throw new Error("Unexpected resource command");
            onValidate(args);
            return { valid: true } as T;
          },
          listen() {
            throw new Error("No events");
          },
        });
        const client = new ChannelClient(protocol);
        const services = {
          zcodeAgentService: ProxyChannel.toService<IZCodeAgentService>(
            client.getChannel(IZCodeAgentService.channelName),
          ),
        };
        resolve({
          services,
          dispose() {
            server.dispose();
            client.dispose();
            protocol.dispose();
            socket.close();
            data.dispose();
            close.dispose();
          },
        });
      });
    },
  );
}

async function expectWebSocketOpens(url: string): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
  return socket;
}

function wrapClientWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

async function connectChannelClient(
  url: string,
  headers?: Record<string, string>,
): Promise<{ client: ChannelClient; dispose: () => void }> {
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  // ChannelServer 在 upgrade 完成后立刻推送 Initialize 帧，message 监听必须在 open 之前挂好。
  const client = new ChannelClient(new SocketProtocol(wrapClientWebSocket(socket)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
  return {
    client,
    dispose: () => {
      client.dispose();
      socket.close();
    },
  };
}

async function expectWebSocketRejected(url: string, statusCode: number): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      reject(new Error("websocket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      if (response.statusCode === statusCode) resolve();
      else reject(new Error(`unexpected ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

describe("standalone Server Core ingress", () => {
  const servers: Array<{ close: () => Promise<void>; port: number }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("fences disconnected but unsettled RPC calls before reversible maintenance", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const services = new ServiceCollection().register(IZCodeAgentService, {
      queryConversationCommandsV4: async () => {
        entered();
        await completed;
        return { results: [] };
      },
    } as never);
    const server = await createCoreHttpServer(services);
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    const peer = await connectResourcePeer(base, () => undefined);
    const pending = peer.services.zcodeAgentService
      .queryConversationCommandsV4({ commands: [] } as never)
      .catch(() => undefined);
    try {
      await started;
      peer.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.tryBeginIdleShutdown()).toBe(false);
      finish();
      await pending;
      await vi.waitFor(() => expect(server.tryBeginIdleShutdown()).toBe(true));
      await expect(fetch(base + "/api/server-info")).rejects.toThrow();
      server.resumeAfterMaintenance();
      expect((await fetch(base + "/api/server-info")).status).toBe(200);
    } finally {
      finish();
      peer.dispose();
    }
  });

  it("isolates reverse resource requests between Desktop peers and excludes normal WebSocket clients", async () => {
    const peers = createTopicResourcePeers();
    const attached = vi.spyOn(peers, "attach");
    const services = new ServiceCollection().register(IZCodeAgentService, {
      queryConversationCommandsV4: async () => ({ results: [] }),
    } as never);
    const server = await createCoreHttpServer(services, { topicResourcePeers: peers });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    await expectWebSocketOpens(`${base.replace("http:", "ws:")}/ws`);
    expect(attached).not.toHaveBeenCalled();
    const firstRead = vi.fn();
    const secondRead = vi.fn();
    const first = await connectResourcePeer(base, firstRead);
    const second = await connectResourcePeer(base, secondRead);
    const request = {
      requestId: "request-a",
      taskId: "task-a",
      inputId: "input-a",
      authorizationId: "auth-a",
      messageId: "message-a",
      resourceIndex: 0,
      workspacePath: "/work",
      workspaceIdentity: "server://same/work",
      remoteSessionId: "remote-a",
    };
    const other = { ...request, remoteSessionId: "remote-b" };
    try {
      await first.services.zcodeAgentService.queryConversationCommandsV4({
        ...request,
        commands: [],
      });
      await second.services.zcodeAgentService.queryConversationCommandsV4({
        ...other,
        commands: [],
      });
      expect(attached).toHaveBeenCalledTimes(2);
      await expect(peers.getChannel(request).call("validate", request)).resolves.toEqual({
        valid: true,
      });
      expect(firstRead).toHaveBeenCalledOnce();
      expect(secondRead).not.toHaveBeenCalled();
      first.dispose();
      await vi.waitFor(() => expect(() => peers.getChannel(request)).toThrow(/unavailable/));
      await expect(peers.getChannel(other).call("validate", other)).resolves.toEqual({
        valid: true,
      });
      expect(secondRead).toHaveBeenCalledOnce();
      expect(() =>
        peers.getChannel({ ...other, workspaceIdentity: "server://different/work" }),
      ).toThrow();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("maps canonical resource requests back to the Desktop stable workspace identity", async () => {
    const mapper = new SourceServerWorkspaceIdentityMapper();
    const stableIdentity = "server://installation/work";
    const canonicalIdentity = "source-workspace-canonical";
    mapper.register({ stableIdentity, canonicalIdentity });
    const peers = createTopicResourcePeers();
    const query = vi.fn(async () => ({ results: [] }));
    const services = new ServiceCollection().register(IZCodeAgentService, {
      queryConversationCommandsV4: query,
    } as never);
    const server = await createCoreHttpServer(services, {
      topicResourcePeers: peers,
      workspaceIdentityMapper: mapper,
    });
    servers.push(server);
    const onValidate = vi.fn();
    const peer = await connectResourcePeer(`http://${server.host}:${server.port}`, onValidate);
    const request = {
      requestId: "resource-request",
      taskId: "task",
      inputId: "input",
      authorizationId: "authorization",
      messageId: "message",
      resourceIndex: 0,
      workspacePath: "/work",
      workspaceIdentity: stableIdentity,
      remoteSessionId: "remote-session",
    };
    try {
      await peer.services.zcodeAgentService.queryConversationCommandsV4({
        ...request,
        commands: [],
      });
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceIdentity: canonicalIdentity }),
      );
      const canonicalRequest = { ...request, workspaceIdentity: canonicalIdentity };
      await peers.getChannel(canonicalRequest).call("validate", canonicalRequest);
      expect(onValidate).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceIdentity: stableIdentity }),
      );
    } finally {
      peer.dispose();
    }
  });

  it("serves server-info on loopback and gates desktop continuous WS", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    const info = await fetch(`http://${server.host}:${server.port}/api/server-info`);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      protocolVersion: 1,
      authRequired: false,
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });

    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`);
    expect(rejected.status).toBe(401);

    const capabilityResponse = await fetch(
      `http://${server.host}:${server.port}/api/rpc-host-capability`,
      { method: "POST" },
    );
    const capability = (await capabilityResponse.json()) as { capability: string };
    const socket = new WebSocket(`ws://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability.capability },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.close();
        resolve();
      });
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`unexpected ${response.statusCode}`)),
      );
      socket.once("error", reject);
    });

    // 一次性 ticket：同一 capability 重放必须被拒绝。
    const replayed = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability.capability },
    });
    expect(replayed.status).toBe(401);
  });

  it("publishes the installation-scoped server identity supplied by Supervisor", async () => {
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
    });
    servers.push(server);

    await expect(
      fetch(`http://${server.host}:${server.port}/api/server-info`).then((response) =>
        response.json(),
      ),
    ).resolves.toMatchObject({ serverId: "server-installation-id" });
  });

  it("exposes only anonymous compatibility facts and accepts the ingress token by query", async () => {
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
      ingressToken: "ingress-secret",
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const anonymousResponse = await fetch(`${baseUrl}/api/server-info`);
    expect(anonymousResponse.status).toBe(200);
    const anonymousBody = (await anonymousResponse.json()) as Record<string, unknown>;
    // 安全断言必须检查原始 wire body；先经宽松客户端 schema strip 再检查字段会恒真。
    expect(anonymousBody).not.toHaveProperty("serverId");
    expect(anonymousBody).not.toHaveProperty("workspaces");
    expect(anonymousBody).not.toHaveProperty("capabilities");
    const anonymous = serverRemoteAnonymousInfoSchema.parse(anonymousBody);
    expect(anonymous).toMatchObject({ authRequired: true, protocolVersion: 1 });

    const missingToken = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(missingToken.status).toBe(401);
    expect((await fetch(`${baseUrl}/ws`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/ws/host`)).status).toBe(401);
    await expectWebSocketRejected(`ws://${server.host}:${server.port}/ws`, 401);

    const rejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(rejected.status).toBe(401);

    const authenticated = await fetch(
      `${baseUrl}/api/server-info?token=${encodeURIComponent("ingress-secret")}`,
    );
    expect(authenticated.status).toBe(200);
    expect(serverRemoteInfoSchema.parse(await authenticated.json())).toMatchObject({
      serverId: "server-installation-id",
      authRequired: true,
    });
    await expectWebSocketOpens(
      `ws://${server.host}:${server.port}/ws?token=${encodeURIComponent("ingress-secret")}`,
    );
  });

  it("only lets desktop continuous hosts reach the provider provisioning target", async () => {
    const envelope: ProviderProvisioningEnvelope = {
      schemaVersion: 1,
      syncId: "sync-1",
      sourceRevision: "source-rev-1",
      personalConfig: { providers: {}, modelConfigRules: { providerModelRules: [] } },
      accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
      credentials: [],
    };
    const applied: ProviderProvisioningResult = {
      syncId: "sync-1",
      status: "applied",
      personalProviderCount: 0,
      credentialCount: 0,
      rolledBack: false,
    };
    const apply = vi.fn<IProviderProvisioningTargetService["apply"]>(async () => applied);
    const services = new ServiceCollection().register(IProviderProvisioningTargetService, {
      apply,
    });
    const server = await createCoreHttpServer(services);
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;
    const channelName = IProviderProvisioningTargetService.channelName;

    const webClient = await connectChannelClient(`ws://${server.host}:${server.port}/ws`);
    try {
      await expect(
        webClient.client.getChannel(channelName).call("apply", [envelope]),
      ).rejects.toThrow("Provider Provisioning 仅支持受信 Desktop Host");
      expect(apply).not.toHaveBeenCalled();
    } finally {
      webClient.dispose();
    }

    const capabilityResponse = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    const { capability } = (await capabilityResponse.json()) as { capability: string };
    const hostClient = await connectChannelClient(`ws://${server.host}:${server.port}/ws/host`, {
      "x-zcode-rpc-host-capability": capability,
    });
    try {
      await expect(
        hostClient.client.getChannel(channelName).call("apply", [envelope]),
      ).resolves.toEqual(applied);
      expect(apply).toHaveBeenCalledWith(envelope);
    } finally {
      hostClient.dispose();
    }
  });

  it("Share RPC 只接受 Host 的可信下游，普通 Web 不能伪造 desktop 身份", async () => {
    const rows = vi.fn(async (input: unknown) => ({
      connection: readTrustedZCodeAgentV4Connection(input),
    }));
    const preflight = vi.fn(() => {
      throw new Error("不能直接调用未绑定 scope 的 ShareService");
    });
    const service = {
      preflight,
      [conversationShareConnectionScopeFactory]: (agent: IZCodeAgentService) => ({
        preflight: (input: never) => agent.conversationRowsRangeV4(input),
      }),
    };
    const services = new ServiceCollection()
      .register(IZCodeAgentService, { conversationRowsRangeV4: rows } as never)
      .register(IConversationShareService, service as never);
    const server = await createCoreHttpServer(services);
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;
    const input = {
      workspacePath: "/remote",
      sessionId: "session",
      __zcodeTrustedV4Connection: { connectionId: "desktop", clientMode: "desktop-continuous" },
    };
    const web = await connectChannelClient(`ws://${server.host}:${server.port}/ws`);
    try {
      await expect(
        web.client.getChannel("conversation-share").call("preflight", [input]),
      ).rejects.toThrow("only available from Desktop");
      expect(rows).not.toHaveBeenCalled();
    } finally {
      web.dispose();
    }
    const response = await fetch(`${baseUrl}/api/rpc-host-capability`, { method: "POST" });
    const { capability } = (await response.json()) as { capability: string };
    const host = await connectChannelClient(`ws://${server.host}:${server.port}/ws/host`, {
      "x-zcode-rpc-host-capability": capability,
    });
    try {
      const direct = await host.client
        .getChannel("zcode-agent")
        .call("conversationRowsRangeV4", [input]);
      await expect(
        host.client.getChannel("conversation-share").call("preflight", [input]),
      ).resolves.toEqual(direct);
      await expect(
        host.client
          .getChannel("conversation-share")
          .call("preflight", [{ workspacePath: "/remote", sessionId: "session" }]),
      ).rejects.toThrow("not trusted");
      expect(preflight).not.toHaveBeenCalled();
    } finally {
      host.dispose();
    }
  });

  it("closes the HTTP server while an upgraded WebSocket remains open", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    const socket = await openWebSocket(`ws://${server.host}:${server.port}/ws`);
    servers.push(server);

    const completed = await Promise.race([
      server.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);

    socket.terminate();
    servers.splice(servers.indexOf(server), 1);
    expect(completed).toBe(true);
  });

  it("rejects expired host capabilities", async () => {
    let now = 0;
    const server = await createCoreHttpServer(new ServiceCollection(), {
      hostCapabilityStore: createHostCapabilityStore({ ttlMs: 100, now: () => now }),
    });
    servers.push(server);
    const issued = await fetch(`http://${server.host}:${server.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    const { capability, expiresAt } = (await issued.json()) as {
      capability: string;
      expiresAt: number;
    };
    expect(expiresAt).toBe(100);
    now = 101;
    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability },
    });
    expect(rejected.status).toBe(401);
  });

  it.each(["raw", "digest"])(
    "requires the %s credential for HTTP, capabilities and WebSocket ingress",
    async (mode) => {
      const token = "synthetic-instance-token";
      const digest = createHash("sha256").update(token).digest("hex");
      const server = await createCoreHttpServer(new ServiceCollection(), {
        host: "0.0.0.0",
        ...(mode === "digest" ? { authTokenHash: digest } : { authToken: token }),
      });
      servers.push(server);
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/server-info`)).status).toBe(401);
      expect((await fetch(`${base}/api/rpc-host-capability`, { method: "POST" })).status).toBe(401);
      const headers = { Authorization: `Bearer ${token}` };
      const info = await fetch(`${base}/api/server-info`, { headers });
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({ authRequired: true });
      expect(
        (
          await fetch(`${base}/api/server-info`, {
            headers: { Authorization: "Bearer wrong-instance-token" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/api/server-info`, {
            headers: { Authorization: `Bearer ${digest}` },
          })
        ).status,
      ).toBe(401);
      const denied = new WebSocket(`${base.replace("http:", "ws:")}/ws`);
      await new Promise<void>((resolve, reject) => {
        denied.once("unexpected-response", (_request, response) => {
          try {
            expect(response.statusCode).toBe(401);
            denied.terminate();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        denied.once("error", () => {});
        denied.once("open", () => reject(new Error("unauthenticated WebSocket opened")));
      });
      const admitted = new WebSocket(`${base.replace("http:", "ws:")}/ws`, { headers });
      await new Promise<void>((resolve, reject) => {
        admitted.once("open", () => {
          admitted.close();
          resolve();
        });
        admitted.once("error", reject);
      });
    },
  );

  it("rejects malformed and ambiguous credential configuration", async () => {
    await expect(
      createCoreHttpServer(new ServiceCollection(), { authTokenHash: "invalid" }),
    ).rejects.toThrow("Invalid or ambiguous");
    await expect(
      createCoreHttpServer(new ServiceCollection(), {
        authToken: "synthetic-token",
        authTokenHash: "a".repeat(64),
      }),
    ).rejects.toThrow("Invalid or ambiguous");
  });

  it("rejects non-loopback listeners until authenticated ingress is implemented", async () => {
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0" }),
    ).rejects.toThrow(/non-loopback.*authentication|loopback/i);
  });
});

it("atomically freezes idle ingress and refuses new requests", async () => {
  const server = await createCoreHttpServer(new ServiceCollection(), { host: "127.0.0.1" });
  try {
    expect(server.tryBeginIdleShutdown()).toBe(true);
    expect(server.tryBeginIdleShutdown()).toBe(false);
    await expect(fetch(`http://127.0.0.1:${server.port}/api/server-info`)).rejects.toThrow();
  } finally {
    await server.close();
  }
});

it("refuses idle shutdown while an accepted connection could admit more work", async () => {
  const { connect } = await import("node:net");
  const { once } = await import("node:events");
  const server = await createCoreHttpServer(new ServiceCollection(), { host: "127.0.0.1" });
  const socket = connect(server.port, "127.0.0.1");
  try {
    await once(socket, "connect");
    const received = once(socket, "data");
    socket.write(
      "GET /api/server-info HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
    );
    await received;
    expect(server.tryBeginIdleShutdown()).toBe(false);
  } finally {
    socket.destroy();
    await server.close();
  }
});

it("keeps continuation control private to the configured instance credential", async () => {
  const command = {
    kind: "read" as const,
    session: "private-session",
    operation: "c633452f-c6d7-4654-a5a4-3f3f8f2b1fb0",
  };
  const control = vi.fn(async () => ({
    session: command.session,
    operation: command.operation,
    state: "active" as const,
    generation: 1,
    version: "version-1",
    digest: null,
  }));
  const server = await createCoreHttpServer(new ServiceCollection(), {
    authToken: "synthetic-private-instance",
    continuation: { control },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const bearer of [undefined, "synthetic-wrong"]) {
      const response = await fetch(base + "/api/continuation-control", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          connection: "close",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(401);
    }
    expect(control).not.toHaveBeenCalled();
    const response = await fetch(base + "/api/continuation-control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        connection: "close",
        authorization: "Bearer synthetic-private-instance",
      },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(control).toHaveBeenCalledExactlyOnceWith(command);
  } finally {
    await server.close();
  }
});

it("does not turn an upstream ingress token into private continuation authority", async () => {
  const control = vi.fn();
  const server = await createCoreHttpServer(new ServiceCollection(), {
    ingressToken: "synthetic-public-ingress",
    continuation: { control },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/continuation-control`, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-public-ingress",
        connection: "close",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(control).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it("keeps a disconnected continuation request in the native idle drain until it settles", async () => {
  const { connect } = await import("node:net");
  const { once } = await import("node:events");
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const command = {
    kind: "read" as const,
    session: "private-session",
    operation: "c633452f-c6d7-4654-a5a4-3f3f8f2b1fb0",
  };
  const server = await createCoreHttpServer(new ServiceCollection(), {
    authToken: "synthetic-private-instance",
    continuation: {
      control: async () => {
        entered();
        await completed;
        return {
          session: command.session,
          operation: command.operation,
          state: "active",
          generation: 1,
          version: "version-1",
          digest: null,
        };
      },
    },
  });
  const socket = connect(server.port, "127.0.0.1");
  try {
    await once(socket, "connect");
    const body = JSON.stringify(command);
    socket.write(
      `POST /api/continuation-control HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic-private-instance\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await started;
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(server.tryBeginIdleShutdown()).toBe(false);
    finish();
    await vi.waitFor(() => expect(server.tryBeginIdleShutdown()).toBe(true));
  } finally {
    finish();
    socket.destroy();
    await server.close();
  }
});

it("requires the explicit instance credential for private continuation control even on loopback", async () => {
  const operation = "735652bc-e825-449f-9f94-c1a449fe1cc7";
  const control = vi.fn(async () => ({
    session: "synthetic-session",
    operation,
    state: "closed" as const,
    generation: 0,
    version: null,
    digest: null,
  }));
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    authToken: "synthetic-instance-token",
    continuation: { control },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/api/continuation-control`;
    const body = JSON.stringify({ kind: "close", session: "synthetic-session", operation });
    const denied = await fetch(url, {
      method: "POST",
      headers: { Cookie: "synthetic-browser-cookie", Connection: "close" },
      body,
    });
    expect(denied.status).toBe(401);
    expect(control).not.toHaveBeenCalled();
    const accepted = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-instance-token", Connection: "close" },
      body,
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).state).toBe("closed");
    expect(control).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
  }
});
