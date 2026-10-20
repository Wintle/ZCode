import { sanitizeRemoteConnectionLog } from "./connectionLog.js";
import {
  isPublicZCodeErrorCode,
  REMOTE_AUTH_REQUIRED_ERROR_CODE,
  REMOTE_DEVICE_REVOKED_ERROR_CODE,
  REMOTE_PAIRING_CODE_INVALID_ERROR_CODE,
  type PublicZCodeErrorCode,
} from "./errorCodes.js";

export interface RemoteConnectionFailure {
  code: PublicZCodeErrorCode;
  message: string;
  retryable?: boolean;
}

const systemCodes: Record<string, PublicZCodeErrorCode> = {
  ECONNREFUSED: "remote-host-unreachable",
  EHOSTUNREACH: "remote-host-unreachable",
  ENETUNREACH: "remote-host-unreachable",
  // Bug 原因：在线断连后的自动恢复经懒连接 probe 抛出 ECONNRESET；码表缺它时被
  // probe 的阶段兜底改写成 remote-preflight-failed，UI 误报“设备环境不满足安装要求”。
  ECONNRESET: "remote-host-unreachable",
  ETIMEDOUT: "remote-connection-timeout",
  ENOTFOUND: "remote-host-not-found",
  EAI_AGAIN: "remote-host-not-found",
  ENOSPC: "remote-space-insufficient",
  EACCES: "remote-permission-denied",
  EPERM: "remote-permission-denied",
  ABORT_ERR: "remote-connection-canceled",
  ERR_SSH_HOST_KEY_MISMATCH: "remote-host-key-changed",
};
const phaseCodes: Record<string, PublicZCodeErrorCode> = {
  download: "remote-download-failed",
  upload: "remote-upload-failed",
  preflight: "remote-preflight-failed",
  extract: "remote-install-failed",
  "verify-archive": "remote-install-failed",
  verify: "remote-install-failed",
  restart: "remote-install-failed",
  install: "remote-install-failed",
};

/** 空 AggregateError 曾生成空响应，被 Main schema 丢弃后 UI 永久等待。 */
export function normalizeRemoteConnectionError(
  error: unknown,
  phase?: string,
): RemoteConnectionFailure {
  const seen = new Set<unknown>();
  function visit(value: unknown, applyPhaseFallback = false): RemoteConnectionFailure {
    if (seen.has(value))
      return { code: "remote-connection-unknown", message: "Remote connection failed" };
    seen.add(value);
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const message =
      typeof record.message === "string"
        ? record.message.trim()
        : typeof value === "string"
          ? value.trim()
          : "";
    const rawCode = typeof record.code === "string" ? record.code : "";
    const explicitCode = isPublicZCodeErrorCode(rawCode) ? rawCode : undefined;
    // 适配器已确认的领域原因优先于 cause 的文本猜测；阶段包装仍继续寻找更具体的内层原因。
    if (
      explicitCode &&
      explicitCode !== "remote-connection-unknown" &&
      !Object.values(phaseCodes).includes(explicitCode)
    ) {
      return {
        code: explicitCode,
        message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
      };
    }
    for (const child of [
      ...(Array.isArray(record.errors) ? record.errors : []),
      record.cause,
      record.error,
    ]) {
      if (child === undefined) continue;
      const nested = visit(child);
      if (nested.code !== "remote-connection-unknown")
        return { ...nested, message: sanitizeRemoteConnectionLog(message) || nested.message };
    }
    let code = explicitCode ?? systemCodes[rawCode];
    if (!code && record.name === "AbortError") code = "remote-connection-canceled";
    if (
      !code &&
      /all configured authentication methods failed|authentication failed|SSH\s*认证失败/iu.test(
        message,
      )
    )
      code = "remote-authentication-failed";
    if (
      !code &&
      /\b(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET)\b|connection refused|no route to host/i.test(
        message,
      )
    )
      code = "remote-host-unreachable";
    if (!code && /\bETIMEDOUT\b|timed? out|timeout/i.test(message))
      code = "remote-connection-timeout";
    if (!code && /\b(?:ENOTFOUND|EAI_AGAIN)\b|could not resolve hostname/i.test(message))
      code = "remote-host-not-found";
    if (!code && /no space left on device|\bENOSPC\b/i.test(message))
      code = "remote-space-insufficient";
    if (!code && /permission denied|read-only file system/i.test(message))
      code = "remote-permission-denied";
    // 仅接受 SSH 明确的密钥校验失败，不从普通 handshake/authentication 失败猜测身份变化。
    if (
      !code &&
      /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(message)
    )
      code = "remote-host-key-changed";
    return {
      code:
        code ??
        (message && applyPhaseFallback && phase ? phaseCodes[phase] : undefined) ??
        "remote-connection-unknown",
      message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
      ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    };
  }
  // 未识别的内层 cause 不是阶段失败事实，不能提前覆盖外层已确认的认证等领域码。
  return visit(error, true);
}

/** 取非空字符串正文；配对/401 响应的 message 必须保证非空，UI 才有稳定兜底。 */
function nonEmptyBodyMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 局域网直连受保护端点 401 响应体分类（wire code → 公开错误码）。
 * undefined 表示该 401 没有稳定分类，调用方必须维持既有 HTTP 失败语义，不得猜测归因。
 */
export function classifyRemoteUnauthorizedFailure(
  bodyCode: unknown,
  bodyMessage?: unknown,
): RemoteConnectionFailure | undefined {
  const message = nonEmptyBodyMessage(bodyMessage);
  if (bodyCode === "device-revoked") {
    return {
      code: REMOTE_DEVICE_REVOKED_ERROR_CODE,
      message: message ?? "Remote device credential was revoked",
      retryable: false,
    };
  }
  if (bodyCode === "auth-required") {
    return {
      code: REMOTE_AUTH_REQUIRED_ERROR_CODE,
      message: message ?? "Remote authentication is required",
      retryable: false,
    };
  }
  return undefined;
}

/**
 * POST /api/pair 失败分类。wire 侧四种失败码（invalid / expired / rate-limited / disabled）
 * 规格只为控制端定义同一个公开码：配对阶段内联提示、可改码重试，具体原因由消息承载。
 */
export function classifyRemotePairingFailure(
  bodyCode: unknown,
  bodyMessage?: unknown,
): RemoteConnectionFailure {
  const wireCode = nonEmptyBodyMessage(bodyCode);
  const message =
    nonEmptyBodyMessage(bodyMessage) ?? (wireCode ? `Pairing rejected (${wireCode})` : undefined);
  return {
    code: REMOTE_PAIRING_CODE_INVALID_ERROR_CODE,
    message: message ?? "Pairing request failed",
    retryable: false,
  };
}

/**
 * 握手 401 已分类为「需要重新配对」的两类失败。仅当调用方仍持有未消费的配对码时
 * 驱动一次配对交换；无码场景必须原样上抛，禁止回退成网络错误重试。
 */
export function isRemotePairingRequiredFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === REMOTE_DEVICE_REVOKED_ERROR_CODE || code === REMOTE_AUTH_REQUIRED_ERROR_CODE;
}
