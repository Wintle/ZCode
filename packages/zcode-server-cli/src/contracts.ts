import { sourceServerRunningTasksSchema, type SourceServerRunningTask } from "@zcode/shared";
import { z } from "zod";

export const SERVER_CLI_PROTOCOL_VERSION = 1;
export const SERVER_RUNTIME_NODE_VERSION = "22.16.0";

// 局域网直连（P1）被控端合同：配对码、设备 Token 与监听配置的唯一常量来源。
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_PENDING_CODES = 3;
export const PAIRING_MAX_FAILURES_PER_WINDOW = 5;
export const PAIRING_FAILURE_WINDOW_MS = 60_000;
export const MAX_PAIRED_DEVICES = 16;
// 规格：设备 Token 为 ≥32 字节随机串，只在签发时返回一次。
export const DEVICE_TOKEN_BYTES = 32;
// 规格：lastSeenAt 刷新节流写盘，最多 1 分钟一次。
export const DEVICE_LAST_SEEN_FLUSH_INTERVAL_MS = 60_000;
export const CORE_COMMAND_TIMEOUT_MS = 10_000;
// serve 的监听参数经 env 透传给 Core；配置文件读取见 runtime/paths.ts。
export const SERVER_LISTEN_HOST_ENV = "ZCODE_SERVER_LISTEN_HOST";
export const SERVER_LISTEN_PORT_ENV = "ZCODE_SERVER_LISTEN_PORT";

export const PAIRING_ERROR_CODES = [
  "pairing-code-invalid",
  "pairing-code-expired",
  "pairing-rate-limited",
  "pairing-disabled",
] as const;
export type PairingErrorCode = (typeof PAIRING_ERROR_CODES)[number];
export type AuthFailureCode = "auth-required" | "device-revoked";

/** 判断 IP 字面量（或 host 名）是否回环；用于监听 host 归类（isLoopbackHost）。 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4);
}

/** 监听 host 是否回环（含 127.0.0.0/8、::1、localhost）。 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}

/** 通配 host（0.0.0.0 / ::）已覆盖回环，不能再叠加第二个 loopback 监听（同端口必 EADDRINUSE）。 */
export function isWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "0:0:0:0:0:0:0:0"
  );
}
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// Supervisor 停止/更新链路的时间预算唯一来源；等待 Supervisor 的调用方必须由这里推导，不能各自写死。
export const CORE_STOP_GRACE_TIMEOUT_MS = 5_000;
// Bug 原因：SIGKILL 只会被不可中断等待推迟，Rosetta + swap 的远端按事故时序推算回收约 3.5～5.4 秒；旧的
// 2 秒等待把必然结束的退出误判为 stop-failed，导致 update 失败并让 Supervisor 卡住锁。
export const CORE_KILL_TIMEOUT_MS = 10_000;
export const CORE_READY_TIMEOUT_MS = 15_000;
export const CONTROL_CLOSE_TIMEOUT_MS = 2_000;
// stop 等待方需要覆盖宽限 + 强杀等待 + control socket 关闭，另留状态落盘和锁释放余量。
export const SERVER_STOP_WAIT_TIMEOUT_MS =
  CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS + CONTROL_CLOSE_TIMEOUT_MS + 3_000;

export const lifecycleStateSchema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stop-failed",
  "stopped",
  "crashed",
  "crash-loop-stopped",
  "updating",
  "uninstalling",
  "uninstalled",
]);

export const crashBudgetSchema = z.object({
  windowStartedAt: z.number().int().nonnegative().optional(),
  crashCount: z.number().int().nonnegative(),
  nextRestartDelayMs: z.number().int().nonnegative(),
  exhausted: z.boolean(),
});

export const serverStatusSchema = z
  .object({
    protocolVersion: z.literal(SERVER_CLI_PROTOCOL_VERSION).default(SERVER_CLI_PROTOCOL_VERSION),
    state: lifecycleStateSchema,
    pid: z.number().int().positive().nullable(),
    port: z.number().int().nonnegative().nullable(),
    host: z.string().min(1).nullable(),
    version: z.string().min(1),
    generation: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().nullable().default(null),
    lastExitReason: z.string().max(500).nullable().default(null),
    serviceRegistered: z.boolean(),
    runningTaskCount: z.number().int().nonnegative(),
    crashBudget: crashBudgetSchema,
    updatedAt: z.number().int().nonnegative(),
    // 局域网直连：生效监听地址/端口与配对设施状态；用 default 保证旧 status.json 仍可解析。
    listenHost: z.string().min(1).nullable().default(null),
    listenPort: z.number().int().nonnegative().nullable().default(null),
    pairingReady: z.boolean().default(false),
  })
  .strict();

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type CrashBudgetSnapshot = z.infer<typeof crashBudgetSchema>;
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const runtimeIdentitySchema = z
  .object({
    supervisorVersion: z.string().min(1),
    supervisorReleaseId: z.string().min(1).optional(),
    activeReleaseVersion: z.string().min(1).optional(),
    activeReleaseId: z.string().min(1).optional(),
    coreVersion: z.string().min(1).optional(),
    coreReleaseId: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const updatePreparationResultSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    runningTaskCount: z.number().int().nonnegative(),
  })
  .strict();
export type UpdatePreparationResult = z.infer<typeof updatePreparationResultSchema>;

export function createStoppedServerStatus(
  version: string,
  options: { serviceRegistered?: boolean; now?: number } = {},
): ServerStatus {
  return serverStatusSchema.parse({
    protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
    state: "stopped",
    pid: null,
    port: null,
    host: null,
    version,
    generation: 0,
    startedAt: null,
    lastExitReason: null,
    serviceRegistered: options.serviceRegistered ?? false,
    runningTaskCount: 0,
    crashBudget: {
      crashCount: 0,
      nextRestartDelayMs: CRASH_BACKOFF_MS[0],
      exhausted: false,
    },
    updatedAt: options.now ?? Date.now(),
  });
}

const requestBase = z.object({ id: z.string().trim().min(1).max(128) });
export const controlRequestSchema = z.discriminatedUnion("command", [
  requestBase.extend({ command: z.literal("ping") }),
  requestBase.extend({ command: z.literal("status") }),
  requestBase.extend({ command: z.literal("running-tasks") }),
  requestBase.extend({ command: z.literal("stop") }),
  requestBase.extend({ command: z.literal("restart") }),
  requestBase.extend({ command: z.literal("runtime-identity") }),
  requestBase.extend({ command: z.literal("prepare-update") }),
  requestBase.extend({ command: z.literal("apply-update"), force: z.boolean().optional() }),
  requestBase.extend({ command: z.literal("prepare-uninstall") }),
  requestBase.extend({ command: z.literal("confirm-uninstall"), confirmation: z.string() }),
  // 局域网直连管理命令：经既有 control socket 转发到运行中的 Core，不另起管理通道。
  requestBase.extend({ command: z.literal("pair") }),
  requestBase.extend({ command: z.literal("list-devices") }),
  requestBase.extend({
    command: z.literal("revoke-devices"),
    deviceId: z.string().min(1).max(128).optional(),
    all: z.boolean().optional(),
  }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const controlResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ControlResponse = z.infer<typeof controlResponseSchema>;

const runningTasksSchema = z.custom<SourceServerRunningTask[]>(
  (value) => sourceServerRunningTasksSchema.safeParse(value).success,
);

export const coreMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    host: z.string().min(1),
    port: z.number().int().positive(),
    version: z.string().min(1),
    releaseId: z.string().min(1).optional(),
    generation: z.number().int().nonnegative(),
    // 局域网直连：生效监听与配对设施；旧 Core 的 ready 不带这些字段，optional 保持兼容。
    listenHost: z.string().min(1).optional(),
    listenPort: z.number().int().nonnegative().optional(),
    pairingReady: z.boolean().optional(),
    pairedDeviceCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    runningTasks: runningTasksSchema.optional(),
    at: z.number().int().nonnegative(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task-activity"),
    runningTasks: runningTasksSchema.optional(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("shutdown-ack") }),
  z.object({ type: z.literal("fatal"), message: z.string().max(500) }),
  z.object({ type: z.literal("exit"), reason: z.string().max(500) }),
  // Supervisor→Core 管理命令（pair / list-devices / revoke-devices）的应答。
  z.object({
    type: z.literal("command-result"),
    id: z.string().min(1).max(128),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(500) })
      .optional(),
  }),
]);
export type CoreMessage = z.infer<typeof coreMessageSchema>;

export const coreCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("shutdown") }),
  z.object({ command: z.literal("pair"), id: z.string().min(1).max(128) }),
  z.object({ command: z.literal("list-devices"), id: z.string().min(1).max(128) }),
  z.object({
    command: z.literal("revoke-devices"),
    id: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128).optional(),
    all: z.boolean().optional(),
  }),
]);
export type CoreCommand = z.infer<typeof coreCommandSchema>;

export const releaseManifestSchema = z
  .object({
    // version 会参与 releases/<version>-<target>-<sha> 路径拼接，不能允许 `/`、`\` 或 `..` 穿越 data root。
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    releaseDir: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1).optional(),
    releaseId: z.string().trim().min(1).optional(),
    appVersion: z.string().trim().min(1).optional(),
    target: z.string().trim().min(1).optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().trim().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const releaseCatalogEntrySchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    appVersion: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
      .optional(),
    target: z.string().trim().min(1),
    archiveUrl: z.string().url(),
    manifestUrl: z.string().url().optional(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            sizeBytes: z.number().int().nonnegative(),
            archiveUrl: z.string().url().optional(),
            archiveSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/i)
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const releaseCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(releaseCatalogEntrySchema),
  })
  .strict();
export type ReleaseCatalogEntry = z.infer<typeof releaseCatalogEntrySchema>;
export type ReleaseCatalog = z.infer<typeof releaseCatalogSchema>;

// ---- 局域网直连（P1）wire 契约与持久化 schema ----

/** POST /api/pair 请求体：固定 {code}。 */
export const pairRequestSchema = z.object({ code: z.string().trim().min(1) });

/** POST /api/pair 成功响应：设备 Token 只在此处出现一次。 */
export const pairSuccessSchema = z.object({
  deviceToken: z.string().min(1),
  serverId: z.string().min(1),
});

/** POST /api/pair 失败响应：code 只在可归类失败时出现。 */
export const pairErrorSchema = z.object({
  error: z.string().min(1),
  code: z.enum(PAIRING_ERROR_CODES).optional(),
});

/** 鉴权 401 响应体的稳定错误码。 */
export const authErrorSchema = z.object({
  error: z.string().min(1),
  code: z.enum(["auth-required", "device-revoked"]),
});

/** devices.json 单条设备记录；tokenHash = sha256(base64url token) 的 hex。 */
export const deviceRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

/** devices.json 容器：serverId 为首次配对时生成并持久化的安装级标识。 */
export const devicesFileSchema = z
  .object({
    serverId: z.string().min(1).nullable().default(null),
    devices: z.array(deviceRecordSchema).default([]),
  })
  .strict();
export type DevicesFile = z.infer<typeof devicesFileSchema>;

/** `serve tokens` 展示条目：不包含 tokenHash，也不回显 token。 */
export const deviceListEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    lastSeenAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().nullable(),
    status: z.enum(["active", "revoked"]),
  })
  .strict();
export type DeviceListEntry = z.infer<typeof deviceListEntrySchema>;

export const deviceListResultSchema = z.object({ devices: z.array(deviceListEntrySchema) });
export type DeviceListResult = z.infer<typeof deviceListResultSchema>;

export const revokeDevicesResultSchema = z.object({ revoked: z.array(z.string().min(1)) });
export type RevokeDevicesResult = z.infer<typeof revokeDevicesResultSchema>;

/** `serve pair` 的 JSON 输出（不含有效期之外的机密）。 */
export const servePairResultSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  host: z.string().min(1),
  port: z.number().int().positive(),
});
export type ServePairResult = z.infer<typeof servePairResultSchema>;

/** <serverRoot>/server-config.json：监听配置，生效链路 CLI > 配置文件 > 默认。 */
export const serverListenConfigSchema = z
  .object({
    listen: z
      .object({
        host: z.string().trim().min(1).optional(),
        port: z.number().int().min(0).max(65_535).optional(),
      })
      .optional(),
  })
  .strict();
export type ServerListenConfig = z.infer<typeof serverListenConfigSchema>;
