import { matchesServerToken, matchesServerTokenHash } from "@zcode/shared/node";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger, type TopicResourcePeers } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";

export interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
  tryBeginIdleShutdown: () => boolean;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function wrapWebSocket(ws: WebSocket): ISocket {
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

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  resourcePeers?: TopicResourcePeers,
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  const scope = agentService
    ? createZCodeAgentConnectionScope(peer ? peer.wrapAgent(agentService) : agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    authToken?: string;
    authTokenHash?: string;
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
    topicResourcePeers?: TopicResourcePeers;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  let accepting = true;
  app.use("*", async (context, next) => accepting ? await next() : context.json({ error: "Server stopping" }, 503));
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  const authToken = options.authToken?.trim();
  const authTokenHash = options.authTokenHash?.trim();
  if ((authToken && authTokenHash) || (authTokenHash && !/^[a-f0-9]{64}$/i.test(authTokenHash))) {
    throw new Error("Invalid or ambiguous server instance credential configuration");
  }
  if (!isLoopbackHost(host) && !authToken && !authTokenHash) {
    // Public listeners must have an explicitly configured instance credential.
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  if (authToken || authTokenHash) {
    app.use("*", async (context, next) => {
      const authorization = context.req.header("authorization");
      const supplied = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
      const authenticated = authTokenHash
        ? matchesServerTokenHash(supplied, authTokenHash)
        : matchesServerToken(supplied, authToken!);
      if (!authenticated) {
        log.warn(undefined, "Server instance authentication rejected", {
          event: "server.auth.rejected",
          correlationId: randomUUID(),
        });
        return context.json({ error: "Unauthorized" }, 401);
      }
      return await next();
    });
  }
  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(authToken || authTokenHash),
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use("/ws/host", async (context, next) => {
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(
          socket.raw as WebSocket,
          services,
          "desktop-continuous",
          options.topicResourcePeers,
        );
      },
    })),
  );
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    if (!accepting) { socket.destroy(); return; }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    tryBeginIdleShutdown: () => {
      // 与接纳在同一事件循环裁决。保守拒绝所有已接纳 TCP/WS 连接，
      // 避免只读任务快照之后又从旧连接进入新输入的竞态。
      if (!accepting || connections.size || wss.clients.size) return false;
      accepting = false;
      return true;
    },
    close: async () => {
      accepting = false;
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
