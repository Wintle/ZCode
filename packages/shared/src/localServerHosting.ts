/* eslint-disable max-lines -- 「本机作为被控端」面板的跨端契约集中声明：状态投影、操作结果与 IPC 请求校验。 */
import { z } from "zod";

/**
 * 局域网直连（C3 被控端界面配置）共享契约。
 * 面板只投影 CLI 返回的事实：主进程 LocalServerHostingManager 经 zcode CLI
 * （serve status / pair / tokens / tokens revoke / config set / serve --daemon）
 * 取得数据，renderer 不自持设备表、配对码或配置副本。
 */

/** 开启局域网监听时的默认端口，与控制端直连向导 DEFAULT_SERVER_REMOTE_PORT 一致。 */
export const LOCAL_SERVER_DEFAULT_LAN_PORT = 8737;

/** 操作失败的稳定分类码；面板据此渲染可读原因，不静默、不伪造状态。 */
export type LocalServerHostingFailureCode =
  /** 本机找不到 zcode server CLI，UI 给安装引导。 */
  | "cli-unavailable"
  /** CLI 执行超时。 */
  | "timeout"
  /** CLI 返回非零退出码（message 为 CLI 的 error 字段）。 */
  | "command-failed"
  /** CLI 输出无法解析为预期 JSON 投影。 */
  | "invalid-output"
  /** IPC 入参未通过校验。 */
  | "invalid-request"
  /** CLI 未安装或被控端服务未运行（如 pair 在停止态调用）。 */
  | "server-unavailable";

export interface LocalServerHostingFailure {
  code: LocalServerHostingFailureCode;
  message: string;
  /** CLI 原样返回的稳定错误码（如 device-not-found、pairing-rate-limited），有则透传给 UI 分类。 */
  cliCode?: string;
}

/** 所有经 IPC 的操作统一以可序列化结果返回，不依赖 electron handle rejection 传错误码。 */
export type LocalServerHostingOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: LocalServerHostingFailure };

/** 被控端状态投影：一次 status + tokens 调用的完整事实快照。 */
export interface LocalServerHostingStatus {
  /** 本机能否定位并执行 zcode server CLI；false 时 UI 给安装引导。 */
  cliAvailable: boolean;
  /** 有安装证据（OS 服务已注册或存在运行态生命周期状态）。 */
  installed: boolean;
  /** 服务进程当前是否运行（state 为 ready/starting）。 */
  running: boolean;
  /** CLI 生命周期状态原值（ready / stopped / uninstalled …）；CLI 不可用时为 null。 */
  state: string | null;
  /** 生效监听 host；未知时为 null。 */
  listenHost: string | null;
  /** 生效监听端口；未知或动态端口时为 null。 */
  listenPort: number | null;
  /** 监听 host 是否非回环（即已允许局域网连接）。 */
  lanEnabled: boolean;
  /** 已配对（active）设备数；tokens 查询失败时为 null（未知），不伪造 0。 */
  pairedDeviceCount: number | null;
  /** OS 服务是否已注册（serviceRegistered）。 */
  serviceRegistered: boolean;
  /** 被控端版本；未知时为 null。 */
  version: string | null;
  /** 本轮观测中的失败；status 仍是事实投影，面板就地展示分类原因。 */
  failure: LocalServerHostingFailure | null;
}

/** `serve pair --json` 成功输出；配对码只在生成时经 IPC 交给 UI 展示，不落日志。 */
export interface LocalServerPairingCode {
  code: string;
  /** 过期时间戳（毫秒）。 */
  expiresAt: number;
  host: string;
  port: number;
}

/** `serve tokens --json` 单条设备条目（不含 token 与哈希）。 */
export interface LocalServerDeviceEntry {
  id: string;
  name: string;
  lastSeenAt: number;
  status: "active" | "revoked";
}

/** `serve tokens revoke … --json` 输出。 */
export interface LocalServerRevokeResult {
  revoked: string[];
}

export interface LocalServerLanEnabledRequest {
  enabled: boolean;
  /** 仅开启时有意义；缺省 8737；1–65535。 */
  port?: number;
}

export interface LocalServerInstallStartRequest {
  port: number;
}

export interface LocalServerLanToggleResult {
  /** 未安装被控端服务：未做任何写入，UI 需先引导用户确认安装并启动。 */
  needsInstall: boolean;
  /** 本轮是否真实触发了服务重启（服务运行中时 config set 后重启）。 */
  restartRequested: boolean;
  /** 操作后的最新状态投影。 */
  status: LocalServerHostingStatus;
}

/** 本机非回环网卡地址；面板拼 `IP:端口` 展示并可复制。 */
export interface LocalServerAddressEntry {
  address: string;
  family: "IPv4" | "IPv6";
}

export const localServerLanEnabledRequestSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();
export const localServerInstallStartRequestSchema = z
  .object({ port: z.number().int().min(1).max(65_535) })
  .strict();
export const localServerRevokeDeviceRequestSchema = z
  .object({
    /** 设备 id 会作为 CLI 参数传递，限制为 server 生成 id 的字符集，杜绝参数注入。 */
    deviceId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/u, "deviceId contains unsupported characters"),
  })
  .strict();
