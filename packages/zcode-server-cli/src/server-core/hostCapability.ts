import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@zcode/shared";
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_MAX_FAILURES_PER_WINDOW,
  PAIRING_MAX_PENDING_CODES,
  type PairingErrorCode,
} from "../contracts.js";

// 与 packages/server/src/hostCapability.ts 保持一致的一次性短期 ticket 语义。
// 依赖边界禁止从 @zcode/server 的入口导入实现，因此在新包内保留一份等价的
// 纯内存实现，行为以旧 server 的兼容合同为准（TTL、一次性消费、过期清理）。
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

/** 短期、一次性 desktop host capability；只在 Server Core 进程内存中存在。 */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // ticket 无论成功、过期还是重放都先删除，只有首次且 TTL 内的消费能获得
      // trusted-host role，避免可重放的长期提权声明。
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}

// ---- 配对码 store（P1 局域网直连） ----
// 与 host capability 同属"一次性 TTL ticket"家族，但安全边界更严：
// 10 分钟 TTL、一次性消费、同时最多 3 个未消费码、失败退避（1 分钟内至多 5 次失败后
// 临时冻结配对）。配对码大小写不敏感归一（hex 码天然安全），只在生成时返回一次。

export interface PairingStoreOptions {
  ttlMs?: number;
  maxPending?: number;
  maxFailures?: number;
  failureWindowMs?: number;
  now?: () => number;
  createCode?: () => string;
}

export type PairingIssueResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; code: "pairing-rate-limited" | "pairing-code-limit"; error: string };

export type PairingConsumeResult =
  | { ok: true }
  | { ok: false; code: PairingErrorCode; error: string };

export interface PairingStore {
  issue(): PairingIssueResult;
  consume(code: string): PairingConsumeResult;
  /** 失败窗口内达到上限即冻结（issue 与 consume 都拒绝）。 */
  isFrozen(at?: number): boolean;
}

export function createPairingStore(options: PairingStoreOptions = {}): PairingStore {
  const ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
  const maxPending = options.maxPending ?? PAIRING_MAX_PENDING_CODES;
  const maxFailures = options.maxFailures ?? PAIRING_MAX_FAILURES_PER_WINDOW;
  const failureWindowMs = options.failureWindowMs ?? PAIRING_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  // ≥40 bit 熵：8 字节随机 → 16 位 hex（64 bit），且 hex 天然大小写不敏感归一。
  const createCode = options.createCode ?? (() => randomBytes(8).toString("hex"));
  const expiresByCode = new Map<string, number>();
  const failureTimestamps: number[] = [];

  const pruneExpired = (at: number): void => {
    for (const [code, expiresAt] of expiresByCode) {
      if (expiresAt <= at) expiresByCode.delete(code);
    }
  };

  const pruneFailures = (at: number): void => {
    const cutoff = at - failureWindowMs;
    while (failureTimestamps.length > 0) {
      const oldest = failureTimestamps[0];
      if (oldest === undefined || oldest > cutoff) break;
      failureTimestamps.shift();
    }
  };

  const frozenUntil = (at: number): number | undefined => {
    pruneFailures(at);
    if (failureTimestamps.length < maxFailures) return undefined;
    // 滑动窗口：第 maxFailures 个失败记录老化出窗口后自动解冻。
    const threshold = failureTimestamps[failureTimestamps.length - maxFailures];
    return threshold === undefined ? undefined : threshold + failureWindowMs;
  };

  const recordFailure = (at: number): void => {
    failureTimestamps.push(at);
    pruneFailures(at);
  };

  const rateLimited = (at: number): PairingConsumeResult & { ok: false } => {
    const until = frozenUntil(at) ?? at + failureWindowMs;
    const retrySeconds = Math.max(1, Math.ceil((until - at) / 1000));
    return {
      ok: false,
      code: "pairing-rate-limited",
      error: `Pairing is temporarily frozen after ${maxFailures} failed attempts; retry in ${retrySeconds}s`,
    };
  };

  return {
    issue() {
      const at = now();
      const frozen = frozenUntil(at);
      if (frozen !== undefined) {
        return { ok: false, code: "pairing-rate-limited", error: rateLimited(at).error };
      }
      pruneExpired(at);
      if (expiresByCode.size >= maxPending) {
        return {
          ok: false,
          code: "pairing-code-limit",
          error: `Too many active pairing codes (max ${maxPending}); wait for one to expire or be used`,
        };
      }
      let code = createCode().trim().toLowerCase();
      while (expiresByCode.has(code)) code = createCode().trim().toLowerCase();
      const expiresAt = at + ttlMs;
      expiresByCode.set(code, expiresAt);
      return { ok: true, code, expiresAt };
    },
    consume(rawCode) {
      const at = now();
      // 冻结判定先于查码：冻结期间既不消费也不计失败，避免被限流的请求延长冻结。
      if (frozenUntil(at) !== undefined) return rateLimited(at);
      const code = rawCode.trim().toLowerCase();
      const expiresAt = expiresByCode.get(code);
      // 无论结果如何先删除，保证一次性消费（错码/过期码同样不得重放）。
      expiresByCode.delete(code);
      if (expiresAt === undefined) {
        recordFailure(at);
        return { ok: false, code: "pairing-code-invalid", error: "Invalid pairing code" };
      }
      if (expiresAt <= at) {
        recordFailure(at);
        return { ok: false, code: "pairing-code-expired", error: "Pairing code expired" };
      }
      // 成功配对终止"连续错误"计数；窗口内残留失败清零。
      failureTimestamps.length = 0;
      return { ok: true };
    },
    isFrozen(at) {
      return frozenUntil(at ?? now()) !== undefined;
    },
  };
}
