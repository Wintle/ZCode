import { scopeConversationShareServiceForAttachment } from "@zcode/services/node";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, userInfo } from "node:os";
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
import {
  MAX_PAIRED_DEVICES,
  isLoopbackHost,
  isWildcardHost,
  pairRequestSchema,
  type PairingErrorCode,
} from "../contracts.js";
import {
  createHostCapabilityStore,
  type HostCapabilityStore,
  type PairingStore,
} from "./hostCapability.js";
import type { DeviceTokenStore } from "./ingressToken.js";

export interface CoreHttpServer {
  host: string;
  port: number;
  /** 生效监听地址/端口（非回环配置时与 loopback 主监听不同）。 */
  listenHost: string;
  listenPort: number;
  close: () => Promise<void>;
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

function timingSafeTokenEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/** 从 Bearer header 或 ?token= 查询参数提取候选凭据（与既有 ingress 语义一致）。 */
function extractCandidateToken(context: {
  req: { header(name: string): string | undefined; url: string };
}): string | undefined {
  const authorization = context.req.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
  const queryToken = new URL(context.req.url).searchParams.get("token")?.trim();
  return bearerToken || queryToken || undefined;
}

/** 配对失败状态码映射；pairing-disabled 表示本机未启用配对设施（非 peer 限制）。 */
function pairingStatusFor(code: PairingErrorCode): 400 | 403 | 410 | 429 {
  if (code === "pairing-rate-limited") return 429;
  if (code === "pairing-disabled") return 403;
  if (code === "pairing-code-expired") return 410;
  return 400;
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
): void {
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
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    ingressToken?: string;
    migrationFailedPathCount?: number;
    hostCapabilityStore?: HostCapabilityStore;
    workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
    topicResourcePeers?: TopicResourcePeers;
    /** 设备 Token 存储；提供即启用设备鉴权与 POST /api/pair 配对签发。 */
    deviceStore?: DeviceTokenStore;
    /** 配对码 store；与 deviceStore 同时提供时配对可用。 */
    pairingStore?: PairingStore;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (!isLoopbackHost(host) && requestedPort < 1) {
    // 规格：非回环监听未给端口必须 fail-fast；port 0 会退化成动态端口，控制端无法定位。
    throw new Error(
      `Non-loopback host ${host} requires an explicit port (1-65535); refusing to listen on a dynamic port`,
    );
  }
  const ingressToken = options.ingressToken?.trim();
  const deviceStore = options.deviceStore;
  const pairingStore = options.pairingStore;
  // fail-closed 语义：非回环监听必须带鉴权（ingress 或设备 Token 校验任一可用）；
  // 两者都无法启用时拒绝启动，不允许出现无鉴权的对外监听。
  const authRequired = Boolean(ingressToken) || Boolean(deviceStore);
  if (!isLoopbackHost(host) && !authRequired) {
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  const info: ServerRemoteInfo = serverRemoteInfoOutputSchema.parse({
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired,
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
    // /api/pair 不做 ingress/设备 token 校验：消费安全性由码熵、一次性消费、TTL 与失败退避保证；
    // 其余端点的 token 校验与 401 稳定 code 语义不变。
    if (context.req.path === "/api/pair") {
      await next();
      return;
    }
    if (!authRequired) {
      await next();
      return;
    }
    const candidate = extractCandidateToken(context);
    if (candidate) {
      if (ingressToken && timingSafeTokenEqual(ingressToken, candidate)) {
        await next();
        return;
      }
      if (deviceStore) {
        const verdict = deviceStore.verify(candidate);
        if (verdict.status === "valid") {
          await next();
          return;
        }
        if (verdict.status === "revoked") {
          return context.json(
            { error: "Device token has been revoked", code: "device-revoked" },
            401,
          );
        }
      }
    }
    if (context.req.path === "/api/server-info") {
      return context.json({
        version: info.version,
        protocolVersion: info.protocolVersion,
        authRequired: true,
        compatibility: info.compatibility,
      });
    }
    return context.json({ error: "Authentication required", code: "auth-required" }, 401);
  });
  app.get("/api/server-info", (context) => context.json(info));
  app.post("/api/pair", async (context) => {
    // 生成只经被控机本地命令（serve pair / 控制面 IPC）；消费入口接受任意 peer（含局域网），
    // 不要求预先鉴权——由配对码熵、一次性消费、TTL 与失败退避共同保证安全。
    if (!pairingStore || !deviceStore) {
      return context.json({ error: "Pairing is disabled", code: "pairing-disabled" }, 403);
    }
    const body = await context.req.json<unknown>().catch(() => null);
    const parsed = pairRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: 'Request body must be {"code": string}' }, 400);
    }
    // 先判设备上限再消费配对码：超出上限不应烧掉用户手里的 one-time 码。
    if (deviceStore.activeCount() >= MAX_PAIRED_DEVICES) {
      return context.json(
        {
          error: `Device limit reached (${MAX_PAIRED_DEVICES} active devices); revoke a paired device first`,
        },
        403,
      );
    }
    const consumed = pairingStore.consume(parsed.data.code);
    if (!consumed.ok) {
      return context.json(
        { error: consumed.error, code: consumed.code },
        pairingStatusFor(consumed.code),
      );
    }
    const issued = await deviceStore.issue();
    const serverId = await deviceStore.ensureServerId(info.serverId);
    return context.json({ deviceToken: issued.deviceToken, serverId }, 200);
  });
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(
          socket.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
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
          options.workspaceIdentityMapper,
          options.topicResourcePeers,
        );
      },
    })),
  );
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));

  // Core 始终绑定 loopback；非回环监听在 loopback 之外加绑第二个 listen socket，
  // 两个 socket 共享同一 Hono handler（upgrade 也分别注入同一 wss）。
  const primaryHost = isLoopbackHost(host) || isWildcardHost(host) ? host : "127.0.0.1";
  const secondaryHost = !isLoopbackHost(host) && !isWildcardHost(host) ? host : undefined;
  const listen = async (
    hostname: string,
    port: number,
  ): Promise<{ server: ReturnType<typeof serve>; port: number }> => {
    let resolveListening: (value: { port: number }) => void = () => undefined;
    let rejectListening: (error: Error) => void = () => undefined;
    const listening = new Promise<{ port: number }>((resolvePromise, rejectPromise) => {
      resolveListening = resolvePromise;
      rejectListening = rejectPromise;
    });
    const server = serve({ fetch: app.fetch, hostname, port }, () => {
      const address = server.address();
      resolveListening({
        port: typeof address === "object" && address ? address.port : port,
      });
    });
    // 端口一经绑定就可能收到 upgrade；必须在 listen 完成前注入，避免首帧连接被裸拒。
    injectWebSocket(server);
    // listen 失败必须 reject 让 createCoreHttpServer fail-fast，而不是变成无监听的未捕获 error 事件。
    const onListenError = (error: Error): void => rejectListening(error);
    server.once("error", onListenError);
    try {
      const bound = await listening;
      return { server, port: bound.port };
    } catch (error) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      throw error;
    } finally {
      server.removeListener("error", onListenError);
    }
  };

  const primary = await listen(primaryHost, requestedPort);
  let secondary: { server: ReturnType<typeof serve>; port: number } | undefined;
  if (secondaryHost) {
    try {
      secondary = await listen(secondaryHost, primary.port);
    } catch (error) {
      await new Promise<void>((resolveClose) => primary.server.close(() => resolveClose()));
      throw error;
    }
  }
  return {
    host: primaryHost,
    port: primary.port,
    listenHost: host,
    listenPort: primary.port,
    close: async () => {
      await closeWebSocketServer(wss);
      const servers = [primary.server, secondary?.server].filter(
        (entry): entry is ReturnType<typeof serve> => entry !== undefined,
      );
      await Promise.all(
        servers.map(
          (entry) =>
            new Promise<void>((resolveClose, rejectClose) => {
              entry.close((error?: Error) => (error ? rejectClose(error) : resolveClose()));
            }),
        ),
      );
    },
  };
}
