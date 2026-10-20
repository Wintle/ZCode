import { hostname } from "node:os";
import {
  createServerHostServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createTopicResourcePeers,
} from "@zcode/services/node";
import { IZCodeAgentService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { createIngressToken, createDeviceTokenStore } from "./ingressToken.js";
import { createPairingStore } from "./hostCapability.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import {
  readServerConfig,
  resolveListenTarget,
  resolveServerLayout,
  type ResolvedListenTarget,
} from "../runtime/paths.js";
import {
  SERVER_LISTEN_HOST_ENV,
  SERVER_LISTEN_PORT_ENV,
  coreCommandSchema,
  type CoreCommand,
} from "../contracts.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

/** 生效监听链路：Supervisor 经 env 透传的 CLI flag > <serverRoot>/server-config.json > 默认回环。 */
async function resolveCoreListenTarget(
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<ResolvedListenTarget> {
  const host = process.env[SERVER_LISTEN_HOST_ENV]?.trim() || undefined;
  const portRaw = process.env[SERVER_LISTEN_PORT_ENV]?.trim();
  const port = portRaw ? Number(portRaw) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new Error(`Invalid ${SERVER_LISTEN_PORT_ENV}: ${portRaw}`);
  }
  const config = await readServerConfig(layout);
  return resolveListenTarget({ host, port }, config);
}

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const layout = resolveServerLayout(process.env.ZCODE_SERVER_ROOT?.trim());
  // fail-fast：监听配置在任何重初始化之前解析并校验（非回环缺端口等直接拒绝启动）。
  const listenTarget = await resolveCoreListenTarget(layout);
  const deviceStore = await createDeviceTokenStore(layout);
  const pairingStore = createPairingStore();
  const topicResourcePeers = createTopicResourcePeers();
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  // Built-in Config 物化到所属 Environment 配置根（~/.zcode/v2）而不是 release 自带的 runtime 目录：
  // release 目录是不可变的，同一 releaseId 重装时 assertExistingReleaseMatches 会重算整棵树的
  // 内容哈希，多出的物化文件会让校验失败。
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      sourceServerId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: true,
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    });
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  const ingressToken = await createIngressToken(layout);
  const http = await createCoreHttpServer(services, {
    // 配对过则沿用 devices.json 持久化的安装级 serverId，保证跨安装信息与配对响应一致。
    serverId: deviceStore.serverId ?? sourceServerId,
    ingressToken,
    deviceStore,
    pairingStore,
    host: listenTarget.host,
    port: listenTarget.port,
    migrationFailedPathCount,
    workspaceIdentityMapper,
    topicResourcePeers,
  });
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    listenHost: http.listenHost,
    listenPort: http.listenPort,
    pairingReady: true,
    pairedDeviceCount: deviceStore.activeCount(),
    version: ZCODE_VERSION,
    ...(process.env.ZCODE_SERVER_RELEASE_ID?.trim()
      ? { releaseId: process.env.ZCODE_SERVER_RELEASE_ID.trim() }
      : {}),
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({
        type: "task-activity",
        runningTasks: taskActivityTracker.readRunningTasks(),
        runningTaskCount,
      });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({
            type: "task-activity",
            runningTasks: taskActivityTracker.readRunningTasks(),
            runningTaskCount,
          });
        }
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount,
        });
      })
      .catch(() => {
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount: lastRunningTaskCount,
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    // 节流的 lastSeenAt 刷新可能仍在计时；退出前落盘，避免丢失本轮活跃记录。
    await deviceStore.flush().catch(() => undefined);
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  const runManagementCommand = async (
    command: Exclude<CoreCommand, { command: "shutdown" }>,
  ): Promise<unknown> => {
    switch (command.command) {
      case "pair": {
        const issued = pairingStore.issue();
        if (!issued.ok) throw Object.assign(new Error(issued.error), { code: issued.code });
        return {
          code: issued.code,
          expiresAt: issued.expiresAt,
          host: http.listenHost,
          port: http.listenPort,
        };
      }
      case "list-devices":
        return { devices: deviceStore.list() };
      case "revoke-devices": {
        // exactly-one 校验：all 与 deviceId 必须且只能给一个（undefined 与 false 等价判断）。
        if (Boolean(command.all) === Boolean(command.deviceId)) {
          throw Object.assign(new Error("revoke-devices requires exactly one of deviceId or all"), {
            code: "invalid-revoke-scope",
          });
        }
        if (command.all) return { revoked: await deviceStore.revokeAll() };
        const revoked = await deviceStore.revoke(command.deviceId ?? "");
        if (!revoked) {
          throw Object.assign(new Error(`Device ${command.deviceId} not found`), {
            code: "device-not-found",
          });
        }
        return { revoked: [revoked] };
      }
    }
  };
  process.on("message", (message: unknown) => {
    const parsed = coreCommandSchema.safeParse(message);
    if (!parsed.success) return;
    const command = parsed.data;
    if (command.command === "shutdown") {
      void shutdown("requested");
      return;
    }
    // 管理命令应答：Core 侧任何失败都折叠成结构化 command-result，不让 IPC 回调悬挂。
    void (async () => {
      try {
        const result = await runManagementCommand(command);
        await send({ type: "command-result", id: command.id, ok: true, result });
      } catch (error: unknown) {
        const rawCode =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        await send({
          type: "command-result",
          id: command.id,
          ok: false,
          error: {
            code: typeof rawCode === "string" && rawCode ? rawCode : "command-failed",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          },
        });
      }
    })();
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
