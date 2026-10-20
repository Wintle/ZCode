import { WebSocket, type RawData } from "ws";
import { RemoteServiceAccess } from "@zcode/client";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type IServerChannel,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  classifyRemotePairingFailure,
  classifyRemoteUnauthorizedFailure,
  isRemotePairingRequiredFailure,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  serverRemotePairResponseSchema,
  type RemoteConnectionFailure,
  type ServerConnectOptions,
  type ServerRemoteInfo,
  type ServerRemotePairResponse,
} from "@zcode/shared";
import {
  connectWebSocketOverDuplex,
  createReusableDuplexHttpAgent,
  requestJsonOverDuplex,
  type ServerRemoteDuplexFactory,
} from "./serverRemoteDuplexTransport.js";

export interface ServerRemoteEndpoints {
  infoUrl: string;
  wsUrl: string;
  pairUrl: string;
  hostCapabilityUrl: string;
  hostWsUrl: string;
}

export interface ServerRemoteConnection {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  dispose(): void;
}

export interface ServerRemoteConnectionOptions {
  signal?: AbortSignal;
  /** name 仅在连接目标缺省时补充 server-info 提供的默认设备名，快照侧不覆盖已有命名。 */
  commitMembership?(sourceServerId: string, facts?: { name?: string }): Promise<void>;
  topicResourceChannel?: IServerChannel;
  fetchImpl?: typeof fetch;
  onClose?: (event: { code: number; reason: string }) => void;
  /**
   * 配对换取到设备 Token 后立即回传；连接层不落盘，凭据持久化由调用方
   * 既有的手工输入 token 路径唯一负责（单一 owner，不新增第二条写入路径）。
   */
  onDeviceToken?(deviceToken: string, pairing: { serverId: string }): Promise<void> | void;
}

export interface ServerRemoteDuplexConnectionOptions {
  topicResourceChannel?: IServerChannel;
  ingressToken: string;
  createConnection: ServerRemoteDuplexFactory;
  onClose?: (event: { code: number; reason: string }) => void;
}

function appendEndpointPath(basePath: string, endpointPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/g, "");
  return normalizedBase ? `${normalizedBase}${endpointPath}` : endpointPath;
}

function stripWebSocketEndpointPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/g, "");
  if (normalizedPath.endsWith("/ws/host")) {
    return normalizedPath.slice(0, -"/ws/host".length);
  }
  if (normalizedPath.endsWith("/ws")) {
    return normalizedPath.slice(0, -"/ws".length);
  }
  return normalizedPath;
}

export function resolveServerRemoteEndpoints(serverUrl: string): ServerRemoteEndpoints {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    throw new Error("Server URL is required");
  }

  const infoUrl = new URL(trimmedUrl);
  const wsUrl = new URL(trimmedUrl);
  const pairUrl = new URL(trimmedUrl);
  const hostCapabilityUrl = new URL(trimmedUrl);
  const hostWsUrl = new URL(trimmedUrl);
  const infoBasePath = stripWebSocketEndpointPath(infoUrl.pathname);
  const wsBasePath = stripWebSocketEndpointPath(wsUrl.pathname);
  const pairBasePath = stripWebSocketEndpointPath(pairUrl.pathname);
  const hostCapabilityBasePath = stripWebSocketEndpointPath(hostCapabilityUrl.pathname);
  const hostWsBasePath = stripWebSocketEndpointPath(hostWsUrl.pathname);

  switch (infoUrl.protocol) {
    case "http:":
    case "https:":
      wsUrl.protocol = infoUrl.protocol === "https:" ? "wss:" : "ws:";
      pairUrl.protocol = infoUrl.protocol;
      hostWsUrl.protocol = wsUrl.protocol;
      break;
    case "ws:":
    case "wss:":
      infoUrl.protocol = infoUrl.protocol === "wss:" ? "https:" : "http:";
      pairUrl.protocol = infoUrl.protocol;
      hostCapabilityUrl.protocol = infoUrl.protocol;
      break;
    default:
      throw new Error(`Unsupported server URL protocol: ${infoUrl.protocol}`);
  }

  infoUrl.pathname = appendEndpointPath(infoBasePath, "/api/server-info");
  wsUrl.pathname = appendEndpointPath(wsBasePath, "/ws");
  pairUrl.pathname = appendEndpointPath(pairBasePath, "/api/pair");
  hostCapabilityUrl.pathname = appendEndpointPath(
    hostCapabilityBasePath,
    "/api/rpc-host-capability",
  );
  hostWsUrl.pathname = appendEndpointPath(hostWsBasePath, "/ws/host");
  infoUrl.search = "";
  wsUrl.search = "";
  pairUrl.search = "";
  hostCapabilityUrl.search = "";
  hostWsUrl.search = "";
  infoUrl.hash = "";
  wsUrl.hash = "";
  pairUrl.hash = "";
  hostCapabilityUrl.hash = "";
  hostWsUrl.hash = "";

  return {
    infoUrl: infoUrl.toString(),
    wsUrl: wsUrl.toString(),
    pairUrl: pairUrl.toString(),
    hostCapabilityUrl: hostCapabilityUrl.toString(),
    hostWsUrl: hostWsUrl.toString(),
  };
}

function authenticatedUrl(url: string, target: ServerConnectOptions): string {
  const token = target.token?.trim();
  if (!token) return url;
  const authenticated = new URL(url);
  authenticated.searchParams.set("token", token);
  return authenticated.toString();
}

function wrapNodeWebSocket(
  ws: WebSocket,
  onClose?: (event: { code: number; reason: string }) => void,
): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onSocketClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  const fireClosed = (code: number, reason: Buffer) => {
    onClose?.({ code, reason: reason.toString("utf8") });
    onSocketClose.fire();
    onEnd.fire();
  };

  ws.on("message", (raw: RawData) => {
    const data = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  ws.on("close", fireClosed);
  ws.on("error", () => {
    onSocketClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onSocketClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
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

function createNodeWebSocketServiceConnection(
  socket: WebSocket,
  onClose?: ServerRemoteConnectionOptions["onClose"],
  topicResourceChannel?: IServerChannel,
): { services: IServiceAccessor; dispose(): void } {
  const protocol = new SocketProtocol(wrapNodeWebSocket(socket, onClose));
  const client = new ChannelClient(protocol);
  const reverseServer = topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, topicResourceChannel);
  const dispose = () => {
    // Bug 根因：仅关闭 socket 会让未完成的 RPC 永久 pending，旧 Provisioning 请求
    // 因而占住 Environment lane，新连接始终无法发布 attachment。由物理连接统一
    // 释放客户端与协议，让旧请求拒绝并沿现有同步失败路径收口；重复释放保持幂等。
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    socket.off("close", dispose);
    socket.off("error", dispose);
  };
  socket.once("close", dispose);
  socket.once("error", dispose);
  return { services: new RemoteServiceAccess(client), dispose };
}

/** 稳定失败码经既有错误码通道上抛；retryable 固定 false，任何重试入口可据此短路。 */
function connectionFailureError(failure: RemoteConnectionFailure): Error {
  return Object.assign(new Error(failure.message), {
    code: failure.code,
    retryable: failure.retryable ?? false,
  });
}

/** 从失败响应正文提取稳定 code 与消息；非 JSON 正文没有稳定分类，返回空。 */
function parseFailureBodyText(text: string): { bodyCode?: unknown; bodyMessage?: unknown } {
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object") return {};
    const record = body as Record<string, unknown>;
    return { bodyCode: record.code, bodyMessage: record.error ?? record.message };
  } catch {
    return {};
  }
}

async function readRemoteFailureBody(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<{ bodyCode?: unknown; bodyMessage?: unknown }> {
  try {
    return parseFailureBodyText(await response.text());
  } catch {
    return {};
  }
}

/**
 * 非 2xx 统一收口：401 先按响应体稳定 code 分类为吊销/需配对再上抛；
 * 无稳定分类时保持既有失败语义（`<label> request failed: <status>`），不猜测归因。
 */
async function assertServerRemoteResponseOk(
  response: Awaited<ReturnType<typeof fetch>>,
  label: string,
): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    const { bodyCode, bodyMessage } = await readRemoteFailureBody(response);
    const failure = classifyRemoteUnauthorizedFailure(bodyCode, bodyMessage);
    if (failure) throw connectionFailureError(failure);
  }
  throw new Error(`${label} request failed: ${response.status}`);
}

/** POST /api/pair：一次性配对码换长期设备 Token；失败按配对失败分类上抛。 */
async function requestServerPairing(input: {
  pairUrl: string;
  pairingCode: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<ServerRemotePairResponse> {
  const response = await input.fetchImpl(input.pairUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.pairingCode }),
    signal: input.signal,
  });
  if (!response.ok) {
    const { bodyCode, bodyMessage } = await readRemoteFailureBody(response);
    throw connectionFailureError(
      classifyRemotePairingFailure(
        bodyCode,
        bodyMessage ?? `Pairing request failed: ${response.status}`,
      ),
    );
  }
  const parsed = serverRemotePairResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error("Pairing response is invalid");
  }
  return parsed.data;
}

async function fetchServerInfo(
  infoUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ServerRemoteInfo> {
  const token = target.token?.trim();
  const response = await fetchImpl(authenticatedUrl(infoUrl, target), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal,
  });
  await assertServerRemoteResponseOk(response, "Server info");
  const rawBody = await response.json();
  const parsed = serverRemoteInfoSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new Error("Server info response is invalid");
  }
  return parsed.data;
}

async function fetchHostCapability(
  capabilityUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(authenticatedUrl(capabilityUrl, target), {
    method: "POST",
    signal,
  });
  await assertServerRemoteResponseOk(response, "Host capability");
  const parsed = serverRemoteHostCapabilitySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Host capability response is invalid");
  }
  return parsed.data.capability;
}

function connectNodeWebSocket(
  wsUrl: string,
  target: ServerConnectOptions,
  capability: string,
  options: ServerRemoteConnectionOptions,
): Promise<{
  socket: WebSocket;
  rpc: ReturnType<typeof createNodeWebSocketServiceConnection>;
}> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const token = target.token?.trim();
    const socket = new WebSocket(authenticatedUrl(wsUrl, target), {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
      },
    });
    let settled = false;
    // 升级被拒绝时响应体由 unexpected-response 消费；socket 的 close/error 不得抢先
    // 用无分类文本 reject，否则 401 的稳定分类永远到不了错误码通道。
    let upgradePending = false;
    const abort = () => {
      socket.terminate();
      reject(options.signal?.reason ?? new Error("远程连接已取消"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const releaseAbort = () => options.signal?.removeEventListener("abort", abort);

    socket.once("error", (error) => {
      releaseAbort();
      if (!settled && !upgradePending) {
        reject(error);
      }
    });
    socket.once("close", (code, reason) => {
      releaseAbort();
      if (!settled && !upgradePending) {
        reject(
          new Error(
            reason.length > 0
              ? `WebSocket closed before ready: ${reason.toString("utf8")}`
              : `WebSocket closed before ready (${code})`,
          ),
        );
      }
    });
    socket.once("unexpected-response", (_request, response) => {
      upgradePending = true;
      const chunks: Buffer[] = [];
      const settle = () => {
        if (settled) return;
        settled = true;
        releaseAbort();
        const status = response.statusCode ?? 0;
        if (status === 401) {
          const { bodyCode, bodyMessage } = parseFailureBodyText(
            Buffer.concat(chunks).toString("utf8"),
          );
          const failure = classifyRemoteUnauthorizedFailure(bodyCode, bodyMessage);
          if (failure) {
            reject(connectionFailureError(failure));
            return;
          }
        }
        reject(new Error(`WebSocket upgrade failed: ${status}`));
      };
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("end", settle);
      response.once("error", settle);
      response.once("close", settle);
    });
    socket.once("open", () => {
      releaseAbort();
      settled = true;
      resolve({
        socket,
        rpc: createNodeWebSocketServiceConnection(
          socket,
          options.onClose,
          options.topicResourceChannel,
        ),
      });
    });
  });
}

export async function connectServerRemote(
  target: ServerConnectOptions,
  options: ServerRemoteConnectionOptions = {},
): Promise<ServerRemoteConnection> {
  options.signal?.throwIfAborted();
  const endpoints = resolveServerRemoteEndpoints(target.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const pairingCode = target.pairingCode?.trim();
  let workingTarget = target;
  let paired = false;

  const exchangePairing = async () => {
    const pairedResult = await requestServerPairing({
      pairUrl: endpoints.pairUrl,
      pairingCode: pairingCode!,
      fetchImpl,
      signal: options.signal,
    });
    paired = true;
    // 连接目标只换成本次换回的设备 Token；pairingCode 与 token 一样不进入任何持久化快照。
    workingTarget = { ...target, token: pairedResult.deviceToken, pairingCode: undefined };
    // 一次性配对码消费后立即回传，凭据持久化由调用方既有路径唯一负责。
    await options.onDeviceToken?.(pairedResult.deviceToken, {
      serverId: pairedResult.serverId,
    });
  };

  // 无可试凭据时先配对再握手（规格时序）；已持有 Token 先握手，
  // 只有 401 被分类为需重新配对时才消费配对码，避免无谓烧掉一次性码。
  if (pairingCode && !target.token?.trim()) {
    await exchangePairing();
  }

  const runHandshake = async () => {
    const serverInfo = await fetchServerInfo(
      endpoints.infoUrl,
      workingTarget,
      fetchImpl,
      options.signal,
    );
    const capability = await fetchHostCapability(
      endpoints.hostCapabilityUrl,
      workingTarget,
      fetchImpl,
      options.signal,
    );
    const socketAndRpc = await connectNodeWebSocket(
      endpoints.hostWsUrl,
      workingTarget,
      capability,
      options,
    );
    return { serverInfo, ...socketAndRpc };
  };

  let handshake: Awaited<ReturnType<typeof runHandshake>>;
  try {
    handshake = await runHandshake();
  } catch (error) {
    // 这是配对消费的唯一第二次触发点：分类为吊销/需配对且配对码在手时换码重连一次；
    // 已配对或无码的失败原样上抛，不构成网络层自动重试。
    if (pairingCode && !paired && isRemotePairingRequiredFailure(error)) {
      await exchangePairing();
      handshake = await runHandshake();
    } else {
      throw error;
    }
  }
  const { serverInfo, socket, rpc } = handshake;

  try {
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Server closed during handshake");
    // serverId 走既有 commit → bindHost 固化进连接目标快照；设备名缺省时由
    // server-info 的 name（其次 hostname）补默认值，快照侧只补缺省不覆盖。
    const defaultDeviceName = target.name?.trim()
      ? undefined
      : serverInfo.name?.trim() || serverInfo.identity?.hostname?.trim() || undefined;
    await options.commitMembership?.(
      serverInfo.serverId,
      defaultDeviceName ? { name: defaultDeviceName } : undefined,
    );
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Server closed during membership commit");
    return {
      serverInfo,
      services: rpc.services,
      dispose() {
        rpc.dispose();
        socket.close();
      },
    };
  } catch (error) {
    // 成员提交失败/连接取消时尚未向 Registry 转移所有权，当前调用必须回收 socket。
    rpc.dispose();
    socket.terminate();
    throw error;
  }
}

export async function connectServerRemoteOverDuplex(
  options: ServerRemoteDuplexConnectionOptions,
): Promise<ServerRemoteConnection> {
  const ingressToken = options.ingressToken.trim();
  if (!ingressToken) throw new Error("Source Server ingress token is required");
  const endpoints = resolveServerRemoteEndpoints("http://source-server.invalid");
  const authorization = { authorization: `Bearer ${ingressToken}` };
  const agent = await createReusableDuplexHttpAgent(options.createConnection);
  let rpc: ReturnType<typeof createNodeWebSocketServiceConnection> | undefined;
  try {
    const infoResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.infoUrl,
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (infoResponse.status < 200 || infoResponse.status >= 300) {
      throw new Error(`Server info request failed: ${infoResponse.status}`);
    }
    const serverInfo = serverRemoteInfoSchema.safeParse(infoResponse.body);
    if (!serverInfo.success) throw new Error("Server info response is invalid");
    const capabilityResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.hostCapabilityUrl,
      method: "POST",
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (capabilityResponse.status < 200 || capabilityResponse.status >= 300) {
      throw new Error(`Host capability request failed: ${capabilityResponse.status}`);
    }
    const capability = serverRemoteHostCapabilitySchema.safeParse(capabilityResponse.body);
    if (!capability.success) throw new Error("Host capability response is invalid");
    const socket = await connectWebSocketOverDuplex({
      url: endpoints.hostWsUrl,
      headers: {
        ...authorization,
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.data.capability,
      },
      createConnection: options.createConnection,
      agent,
      onSocketCreated: (webSocket) => {
        rpc = createNodeWebSocketServiceConnection(
          webSocket,
          options.onClose,
          options.topicResourceChannel,
        );
      },
    });
    if (!rpc) throw new Error("Source Server RPC protocol was not initialized");
    return {
      serverInfo: serverInfo.data,
      services: rpc.services,
      dispose() {
        rpc?.dispose();
        socket.terminate();
        agent.destroy();
      },
    };
  } catch (error) {
    rpc?.dispose();
    agent.destroy();
    throw error;
  }
}
