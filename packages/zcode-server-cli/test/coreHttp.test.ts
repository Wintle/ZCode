import {
  conversationShareConnectionScopeFactory,
  SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  IConversationShareService,
  IZCodeAgentService,
  IProviderProvisioningTargetService,
  ServiceCollection,
  readTrustedZCodeAgentV4Connection,
} from "@zcode/services";
import {
  serverRemoteAnonymousInfoSchema,
  serverRemoteInfoSchema,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
} from "@zcode/shared";
import {
  PAIRING_CODE_TTL_MS,
  authErrorSchema,
  pairErrorSchema,
  pairSuccessSchema,
} from "../src/contracts.js";
import {
  createHostCapabilityStore,
  createPairingStore,
} from "../src/server-core/hostCapability.js";
import { createDeviceTokenStore } from "../src/server-core/ingressToken.js";
import { createCoreHttpServer } from "../src/server-core/http.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  type ISocket,
} from "@zcode/rpc";
import { createTopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";

async function connectResourcePeer(base: string, onValidate: (args: unknown) => void) {
  const response = await fetch(`${base}/api/rpc-host-capability`, { method: "POST" });
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

/** 机器上非回环的 IPv4 地址；无 LAN 环境时跳过依赖真实网卡的用例。 */
const lanAddress =
  Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4))
    ?.address ?? undefined;

/** 预留一个空闲端口（关闭后立即复用，避免非回环监听用例依赖固定端口）。 */
async function reservePort(host: string): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, host, () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("probe did not bind a port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function createLayout(): Promise<ReturnType<typeof resolveServerLayout>> {
  const root = await mkdtemp(join(tmpdir(), "zcode-lan-corehttp-"));
  return resolveServerLayout(join(root, "server"));
}

describe("standalone Server Core ingress", () => {
  const servers: Array<{ close: () => Promise<void>; port: number }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
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

  it("rejects non-loopback listeners when token authentication cannot be enabled", async () => {
    // fail-closed：非回环缺端口优先 fail-fast（未给出的端口不进入监听尝试）。
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0" }),
    ).rejects.toThrow(/explicit port/i);
    // 即使启用了鉴权，非回环缺端口也必须 fail-fast（不允许动态端口对外监听）。
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0", ingressToken: "t" }),
    ).rejects.toThrow(/explicit port/i);
    // fail-closed：没有 ingress / 设备 Token 校验的对外监听一律拒绝启动。
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0", port: 18737 }),
    ).rejects.toThrow(/requires authentication/i);
  });

  it("binds a non-loopback listener once token authentication is enabled", async () => {
    const port = await reservePort("127.0.0.1");
    const server = await createCoreHttpServer(new ServiceCollection(), {
      host: "0.0.0.0",
      port,
      ingressToken: "ingress-secret",
    });
    servers.push(server);
    expect(server.host).toBe("0.0.0.0");
    expect(server.listenHost).toBe("0.0.0.0");
    expect(server.listenPort).toBe(port);
    // 通配监听覆盖回环：本机管理面仍可达，未鉴权请求按既有语义降级。
    const info = await fetch(`http://127.0.0.1:${port}/api/server-info`);
    expect(info.status).toBe(200);
    const anonymous = serverRemoteAnonymousInfoSchema.parse(await info.json());
    expect(anonymous).toMatchObject({ authRequired: true });
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(401);
  });

  it.skipIf(lanAddress === undefined)(
    "keeps the loopback listener and adds a second socket for a specific LAN address",
    async () => {
      const port = await reservePort(lanAddress ?? "127.0.0.1");
      const server = await createCoreHttpServer(new ServiceCollection(), {
        host: lanAddress ?? "",
        port,
        ingressToken: "ingress-secret",
      });
      servers.push(server);
      // Core 始终绑定 loopback（主监听），指定 LAN 地址为第二个 listen socket，共享同一 handler。
      expect(server.host).toBe("127.0.0.1");
      expect(server.listenHost).toBe(lanAddress);
      expect(server.port).toBe(port);
      const viaLoopback = await fetch(`http://127.0.0.1:${port}/api/server-info`);
      expect(viaLoopback.status).toBe(200);
      const viaLan = await fetch(`http://${lanAddress ?? ""}:${port}/api/server-info`);
      expect(viaLan.status).toBe(200);
    },
  );

  it("accepts ingress or device tokens and classifies 401s with stable codes", async () => {
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
      ingressToken: "ingress-secret",
      deviceStore,
    });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    const { deviceToken, device } = await deviceStore.issue({ name: "laptop" });

    // 两类 token 都能拿完整 server-info。
    const viaIngress = await fetch(`${base}/api/server-info`, {
      headers: { authorization: "Bearer ingress-secret" },
    });
    expect(serverRemoteInfoSchema.parse(await viaIngress.json())).toMatchObject({
      serverId: "server-installation-id",
    });
    const viaDevice = await fetch(
      `${base}/api/server-info?token=${encodeURIComponent(deviceToken)}`,
    );
    expect(serverRemoteInfoSchema.parse(await viaDevice.json())).toMatchObject({
      serverId: "server-installation-id",
    });

    // 缺失 / 无效 → auth-required；已吊销 → device-revoked。
    const missing = await fetch(`${base}/api/rpc-host-capability`, { method: "POST" });
    expect(missing.status).toBe(401);
    expect(authErrorSchema.parse(await missing.json()).code).toBe("auth-required");
    const invalid = await fetch(`${base}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(invalid.status).toBe(401);
    expect(authErrorSchema.parse(await invalid.json()).code).toBe("auth-required");

    await deviceStore.revoke(device.id);
    const revoked = await fetch(`${base}/api/server-info`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(revoked.status).toBe(401);
    expect(authErrorSchema.parse(await revoked.json()).code).toBe("device-revoked");
  });

  it("keeps the anonymous server-info degradation when only a device store is enabled", async () => {
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    const server = await createCoreHttpServer(new ServiceCollection(), { deviceStore });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;

    const anonymousBody = await fetch(`${base}/api/server-info`).then((response) =>
      response.json(),
    );
    expect(anonymousBody).not.toHaveProperty("serverId");
    expect(serverRemoteAnonymousInfoSchema.parse(anonymousBody)).toMatchObject({
      authRequired: true,
    });

    const { deviceToken } = await deviceStore.issue();
    const authenticated = await fetch(`${base}/api/server-info`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(serverRemoteInfoSchema.parse(await authenticated.json())).toMatchObject({
      authRequired: true,
    });
  });

  it("pairs over loopback with a live code, issues a working device token, and rejects replay", async () => {
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    const pairingStore = createPairingStore();
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
      ingressToken: "ingress-secret",
      deviceStore,
      pairingStore,
    });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;

    const issued = pairingStore.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const response = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code.toUpperCase() }),
    });
    expect(response.status).toBe(200);
    const payload = pairSuccessSchema.parse(await response.json());
    expect(payload.serverId).toBe("server-installation-id");
    expect(Buffer.from(payload.deviceToken, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(deviceStore.activeCount()).toBe(1);

    // 签发的设备 Token 立即可用；配对码一次性，重放是 invalid。
    const capability = await fetch(`${base}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.deviceToken}` },
    });
    expect(capability.status).toBe(200);
    const replay = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(replay.status).toBe(400);
    expect(pairErrorSchema.parse(await replay.json()).code).toBe("pairing-code-invalid");

    // 非法请求体与错码都是 4xx 契约响应。
    const malformed = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(malformed.status).toBe(400);
    expect(pairErrorSchema.parse(await malformed.json()).error).toBeTruthy();
    const wrong = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "0000000000000000" }),
    });
    expect(wrong.status).toBe(400);
    expect(pairErrorSchema.parse(await wrong.json()).code).toBe("pairing-code-invalid");
  });

  it("returns pairing-code-expired for codes older than the TTL", async () => {
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    let now = 0;
    const pairingStore = createPairingStore({ now: () => now });
    const server = await createCoreHttpServer(new ServiceCollection(), {
      ingressToken: "ingress-secret",
      deviceStore,
      pairingStore,
    });
    servers.push(server);

    const issued = pairingStore.issue();
    if (!issued.ok) throw new Error("issue failed");
    now = PAIRING_CODE_TTL_MS;
    const response = await fetch(`http://${server.host}:${server.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(response.status).toBe(410);
    expect(pairErrorSchema.parse(await response.json()).code).toBe("pairing-code-expired");
    expect(deviceStore.activeCount()).toBe(0);
  });

  it("rate-limits all pairing attempts after 5 failures within a minute", async () => {
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    let now = 0;
    const pairingStore = createPairingStore({ now: () => now });
    const server = await createCoreHttpServer(new ServiceCollection(), {
      ingressToken: "ingress-secret",
      deviceStore,
      pairingStore,
    });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    const attempt = async (code: string): Promise<Response> =>
      fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });

    // 先发一个合法码，冻结期间验证它被拒且未被消费。
    const issued = pairingStore.issue();
    if (!issued.ok) throw new Error("issue failed");
    for (let index = 0; index < 5; index++) {
      const failed = await attempt("0000000000000000");
      expect(failed.status).toBe(400);
      expect(pairErrorSchema.parse(await failed.json()).code).toBe("pairing-code-invalid");
    }
    const limited = await attempt("0000000000000000");
    expect(limited.status).toBe(429);
    expect(pairErrorSchema.parse(await limited.json()).code).toBe("pairing-rate-limited");

    // 冻结期间合法码同样被拒，且不被消费（随后窗口滑过，同一码可成功配对）。
    const duringFreeze = await attempt(issued.code);
    expect(duringFreeze.status).toBe(429);
    expect(deviceStore.activeCount()).toBe(0);
    now += 61_000;
    const afterWindow = await attempt(issued.code);
    expect(afterWindow.status).toBe(200);
    expect(deviceStore.activeCount()).toBe(1);
  });

  it("rejects pairing when disabled and refuses the device limit without burning the code", async () => {
    // 未注入配对设施 → pairing-disabled。
    const disabled = await createCoreHttpServer(new ServiceCollection(), {
      ingressToken: "ingress-secret",
    });
    servers.push(disabled);
    const disabledResponse = await fetch(`http://${disabled.host}:${disabled.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "0000000000000000" }),
    });
    expect(disabledResponse.status).toBe(403);
    expect(pairErrorSchema.parse(await disabledResponse.json()).code).toBe("pairing-disabled");

    // 设备上限：先拒绝配对，但不消费配对码；吊销后同一码仍可配对。
    const layout = await createLayout();
    const deviceStore = await createDeviceTokenStore(layout);
    const pairingStore = createPairingStore();
    const server = await createCoreHttpServer(new ServiceCollection(), {
      ingressToken: "ingress-secret",
      deviceStore,
      pairingStore,
    });
    servers.push(server);
    const first = await deviceStore.issue();
    for (let index = 1; index < 16; index++) await deviceStore.issue();
    const issued = pairingStore.issue();
    if (!issued.ok) throw new Error("issue failed");
    const overLimit = await fetch(`http://${server.host}:${server.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(overLimit.status).toBe(403);
    await deviceStore.revoke(first.device.id);
    const afterRevoke = await fetch(`http://${server.host}:${server.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(afterRevoke.status).toBe(200);
  });

  it.skipIf(lanAddress === undefined)(
    "accepts a LAN peer holding a valid code and folds its failures into the shared backoff",
    async () => {
      const layout = await createLayout();
      const deviceStore = await createDeviceTokenStore(layout);
      let now = 0;
      const pairingStore = createPairingStore({ now: () => now });
      const port = await reservePort(lanAddress ?? "127.0.0.1");
      const server = await createCoreHttpServer(new ServiceCollection(), {
        host: lanAddress ?? "",
        port,
        ingressToken: "ingress-secret",
        deviceStore,
        pairingStore,
      });
      servers.push(server);
      const attempt = async (code: string, peer: "lan" | "loopback"): Promise<Response> =>
        fetch(`http://${peer === "lan" ? (lanAddress ?? "") : "127.0.0.1"}:${port}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });

      // 非回环 peer 持有效码可直接配对成功：不要求预先鉴权，也不再返回 pairing-disabled。
      const issued = pairingStore.issue();
      if (!issued.ok) throw new Error("issue failed");
      const remote = await attempt(issued.code, "lan");
      expect(remote.status).toBe(200);
      expect(deviceStore.activeCount()).toBe(1);

      // 非回环 peer 的错码进入与本机一致的退避：同样计数、同样冻结。
      for (let index = 0; index < 5; index++) {
        const failed = await attempt("0000000000000000", "lan");
        expect(failed.status).toBe(400);
        expect(pairErrorSchema.parse(await failed.json()).code).toBe("pairing-code-invalid");
      }
      const limitedRemote = await attempt("0000000000000000", "lan");
      expect(limitedRemote.status).toBe(429);
      expect(pairErrorSchema.parse(await limitedRemote.json()).code).toBe("pairing-rate-limited");
      // 冻结是共享状态：本机 loopback peer 同时被限流。
      const limitedLocal = await attempt("0000000000000000", "loopback");
      expect(limitedLocal.status).toBe(429);
      expect(pairErrorSchema.parse(await limitedLocal.json()).code).toBe("pairing-rate-limited");

      // 窗口滑过解冻后，LAN peer 的新有效码仍可成功配对。
      now += 61_000;
      expect(pairingStore.isFrozen()).toBe(false);
      const second = pairingStore.issue();
      if (!second.ok) throw new Error("issue failed");
      const afterWindow = await attempt(second.code, "lan");
      expect(afterWindow.status).toBe(200);
      expect(deviceStore.activeCount()).toBe(2);
    },
  );
});
