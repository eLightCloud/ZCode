import { matchesServerToken, matchesServerTokenHash } from "@zcode/shared/node";
import { scopeConversationShareServiceForAttachment } from "@zcode/services/node";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  Event,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
  type IChannel,
  type CancellationToken,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IProviderProvisioningTargetService,
  IZCodeAgentService,
  IConversationShareService,
  ServiceCollection,
} from "@zcode/services";
import {
  createServiceLogger,
  type TopicResourcePeers,
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  serverRemoteInfoOutputSchema,
  ZCODE_COMPATIBILITY_MANIFEST,
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
  resumeAfterMaintenance: () => void;
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
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
): Promise<void> {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const loggedServer = new LoggingChannelServer(rawServer, (...args) =>
    log.debug(undefined, ...args),
  );
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const rawResourceChannel = reverseClient?.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL);
  // Source 内部 route 已 canonicalize；反向请求必须还原 Desktop 的 stable identity，
  // 否则同一 attachment 会被 registry 判成跨工作区请求。
  const resourceChannel: IChannel | undefined =
    rawResourceChannel && workspaceIdentityMapper
      ? {
          async call<T>(command: string, args?: unknown, token?: CancellationToken) {
            const result = await rawResourceChannel.call<T>(
              command,
              workspaceIdentityMapper.mapOutgoing(args),
              token,
            );
            return workspaceIdentityMapper.mapIncoming(result);
          },
          listen<T>(event: string, args?: unknown) {
            return Event.map(
              rawResourceChannel.listen<T>(event, workspaceIdentityMapper.mapOutgoing(args)),
              (value) => workspaceIdentityMapper.mapIncoming(value),
            );
          },
        }
      : rawResourceChannel;
  const peer = resourceChannel ? resourcePeers?.attach(resourceChannel) : undefined;
  const connectionContext = {
    connectionId: `server-core-ws-${randomUUID()}`,
    clientMode,
    role:
      clientMode === "desktop-continuous"
        ? ("trusted-host-relay" as const)
        : ("terminal-client" as const),
  };
  const scope = agentService
    ? createZCodeAgentConnectionScope(
        peer ? peer.wrapAgent(agentService) : agentService,
        connectionContext,
      )
    : undefined;
  const overrides = new Map<string, unknown>();
  if (scope) {
    overrides.set(IZCodeAgentService.channelName, scope.service);
  }
  const shareService = services.getOptional(IConversationShareService);
  if (shareService) {
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        shareService,
        clientMode,
        scope?.service,
        connectionContext,
      ),
    );
  }
  // Provisioning envelope 携带跨 Environment 的 Personal 配置与凭据，只允许受信 Desktop Host
  // 通过 /ws/host 下发；/ws 上的 Web / 手机 replayable 客户端即使知道频道名，也只能拿到抛错 stub，
  // 不能把凭据写进本 Source Server。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    rawServer.dispose();
    void Promise.all([scope?.dispose(), rawServer.whenCallsSettled()]).then(resolveSettled, () => {
      log.warn(undefined, "Connection scope retirement unconfirmed", {
        event: "server.scope_retirement_failed",
      });
    });
  });
  return settled;
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    authToken?: string;
    authTokenHash?: string;
    host?: string;
    port?: number;
    serverId?: string;
    ingressToken?: string;
    migrationFailedPathCount?: number;
    hostCapabilityStore?: HostCapabilityStore;
    workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
    topicResourcePeers?: TopicResourcePeers;
    initiallyPaused?: boolean;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  let accepting = options.initiallyPaused !== true;
  let closing = false;
  const rpcScopes = new Set<Promise<void>>();
  const track = (pending: Promise<void>) => {
    rpcScopes.add(pending);
    void pending.then(() => rpcScopes.delete(pending));
  };
  app.use("*", async (context, next) =>
    accepting ? await next() : context.json({ error: "Server stopping" }, 503),
  );
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
  const ingressToken = options.ingressToken?.trim();
  const info: ServerRemoteInfo = serverRemoteInfoOutputSchema.parse({
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(authToken || authTokenHash || ingressToken),
    workspaces: [],
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: userInfo().username, hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      virtualProjects: true,
      processResourceTelemetry: true,
    },
  });
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  app.use("*", async (context, next) => {
    if (!ingressToken) {
      await next();
      return;
    }
    const authorization = context.req.header("authorization");
    const bearerToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    const queryToken = new URL(context.req.url).searchParams.get("token")?.trim();
    const candidate = bearerToken || queryToken;
    const authenticated = candidate
      ? (() => {
          const expected = Buffer.from(ingressToken);
          const received = Buffer.from(candidate);
          return expected.length === received.length && timingSafeEqual(expected, received);
        })()
      : false;
    if (authenticated) {
      await next();
      return;
    }
    if (context.req.path === "/api/server-info") {
      return context.json({
        version: info.version,
        protocolVersion: info.protocolVersion,
        authRequired: true,
        compatibility: info.compatibility,
      });
    }
    return context.json({ error: "Ingress authentication required" }, 401);
  });
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        track(exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable"));
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
        track(
          exposeWebSocket(
            socket.raw as WebSocket,
            services,
            "desktop-continuous",
            options.workspaceIdentityMapper,
            options.topicResourcePeers,
          ),
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
    if (!accepting) {
      socket.destroy();
      return;
    }
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
      if (!accepting || connections.size || wss.clients.size || rpcScopes.size) return false;
      accepting = false;
      return true;
    },
    resumeAfterMaintenance: () => {
      if (closing) throw new Error("Server is closing");
      accepting = true;
    },
    close: async () => {
      closing = true;
      accepting = false;
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
