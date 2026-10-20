import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  DEVICE_LAST_SEEN_FLUSH_INTERVAL_MS,
  DEVICE_TOKEN_BYTES,
  MAX_PAIRED_DEVICES,
  deviceRecordSchema,
  devicesFileSchema,
  type DeviceListEntry,
  type DeviceRecord,
  type DevicesFile,
} from "../contracts.js";
import type { ServerLayout } from "../runtime/paths.js";

export async function createIngressToken(layout: ServerLayout): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
  const temporary = `${layout.ingressTokenFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, layout.ingressTokenFile);
    if (process.platform !== "win32") await chmod(layout.ingressTokenFile, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return token;
}

// ---- 设备 Token 存储（<serverRoot>/devices.json，0600 原子写） ----
// 规格：服务端只存 sha256(base64url token)；≥32 字节随机 token 只在签发时返回一次；
// 设备跨 Core 重启有效，不参与启动轮换；与 ingress token 职责分离、互不影响。

export type DeviceVerifyResult =
  | { status: "valid"; deviceId: string }
  | { status: "revoked" }
  | { status: "invalid" };

export interface DeviceTokenStore {
  /** 首次配对时生成并持久化的安装级 serverId；未配对过为 null。 */
  readonly serverId: string | null;
  /** 活跃（未吊销）设备数，用于 16 上限判断与启动告警。 */
  activeCount(): number;
  /** 签发新设备 Token；超出上限由调用方先判断 activeCount()。 */
  issue(options?: { name?: string }): Promise<{ deviceToken: string; device: DeviceRecord }>;
  /** 校验候选 Token（timingSafeEqual 比对哈希）；有效时刷新 lastSeenAt。 */
  verify(candidate: string | undefined): DeviceVerifyResult;
  revoke(id: string): Promise<string | null>;
  revokeAll(): Promise<string[]>;
  list(): DeviceListEntry[];
  /** 确保持久化的 serverId 存在；返回当前生效值。 */
  ensureServerId(preferred: string): Promise<string>;
  /** 落盘积压的 lastSeenAt 刷新（shutdown 前调用）。 */
  flush(): Promise<void>;
}

export interface DeviceTokenStoreOptions {
  now?: () => number;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function toHex(hash: Buffer): string {
  return hash.toString("hex");
}

class FileDeviceTokenStore implements DeviceTokenStore {
  private serverIdValue: string | null;
  private readonly devices: DeviceRecord[];
  private readonly now: () => number;
  private lastSeenDirty = false;
  private lastFlushAt: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  public constructor(
    private readonly layout: ServerLayout,
    file: DevicesFile,
    now: () => number,
  ) {
    this.serverIdValue = file.serverId;
    this.devices = file.devices;
    this.now = now;
    this.lastFlushAt = now();
  }

  public get serverId(): string | null {
    return this.serverIdValue;
  }

  public activeCount(): number {
    return this.devices.filter((device) => device.revokedAt === null).length;
  }

  public async issue(
    options: { name?: string } = {},
  ): Promise<{ deviceToken: string; device: DeviceRecord }> {
    if (this.activeCount() >= MAX_PAIRED_DEVICES) {
      throw Object.assign(
        new Error(
          `Device limit reached (${MAX_PAIRED_DEVICES} active devices); revoke a paired device first`,
        ),
        { code: "device-limit" },
      );
    }
    const deviceToken = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const at = this.now();
    const id = randomUUID();
    const device: DeviceRecord = deviceRecordSchema.parse({
      id,
      name: options.name?.trim() || `direct-${id.slice(0, 8)}`,
      tokenHash: toHex(hashToken(deviceToken)),
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
    });
    this.devices.push(device);
    await this.persist();
    // Token 明文只存在于本次返回值与调用方，不落盘、不再回显。
    return { deviceToken, device };
  }

  public verify(candidate: string | undefined): DeviceVerifyResult {
    if (!candidate) return { status: "invalid" };
    const received = hashToken(candidate);
    for (const device of this.devices) {
      const expected = Buffer.from(device.tokenHash, "hex");
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) continue;
      if (device.revokedAt !== null) return { status: "revoked" };
      this.touchLastSeen(device);
      return { status: "valid", deviceId: device.id };
    }
    return { status: "invalid" };
  }

  public async revoke(id: string): Promise<string | null> {
    const device = this.devices.find((entry) => entry.id === id);
    if (!device || device.revokedAt !== null) return null;
    device.revokedAt = this.now();
    await this.persist();
    return device.id;
  }

  public async revokeAll(): Promise<string[]> {
    const revoked: string[] = [];
    const at = this.now();
    for (const device of this.devices) {
      if (device.revokedAt === null) {
        device.revokedAt = at;
        revoked.push(device.id);
      }
    }
    if (revoked.length > 0) await this.persist();
    return revoked;
  }

  public list(): DeviceListEntry[] {
    return this.devices.map((device) => ({
      id: device.id,
      name: device.name,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
      status: device.revokedAt === null ? ("active" as const) : ("revoked" as const),
    }));
  }

  public async ensureServerId(preferred: string): Promise<string> {
    if (this.serverIdValue) return this.serverIdValue;
    this.serverIdValue = preferred;
    await this.persist();
    return this.serverIdValue;
  }

  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.lastSeenDirty) {
      await this.inFlight;
      return;
    }
    this.lastSeenDirty = false;
    this.lastFlushAt = this.now();
    await this.persist();
  }

  private touchLastSeen(device: DeviceRecord): void {
    device.lastSeenAt = this.now();
    this.lastSeenDirty = true;
    const elapsed = this.now() - this.lastFlushAt;
    if (elapsed >= DEVICE_LAST_SEEN_FLUSH_INTERVAL_MS) {
      this.lastSeenDirty = false;
      this.lastFlushAt = this.now();
      void this.persist().catch(() => undefined);
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.lastSeenDirty) return;
      this.lastSeenDirty = false;
      this.lastFlushAt = this.now();
      void this.persist().catch(() => undefined);
    }, DEVICE_LAST_SEEN_FLUSH_INTERVAL_MS - elapsed);
    // 刷新计时器不应阻止进程退出；真实写盘由 flush()/shutdown 兜底。
    this.flushTimer.unref?.();
  }

  private persist(): Promise<void> {
    const file: DevicesFile = { serverId: this.serverIdValue, devices: this.devices };
    // 写入串行化；链本身吞掉失败避免后续写入永久排队，单次写入的结果仍返回给调用方：
    // 签发/吊销 await 它并在失败时上抛，lastSeenAt 刷新为 best-effort。
    const run = this.inFlight
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.layout.serverRoot, { recursive: true, mode: 0o700 });
        const temporary = `${this.layout.devicesFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temporary, this.layout.devicesFile);
          if (process.platform !== "win32") await chmod(this.layout.devicesFile, 0o600);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
    this.inFlight = run.catch(() => undefined);
    return run;
  }
}

/**
 * 打开设备存储（缺失视为尚无设备）。文件损坏时 fail-closed：宁可拒绝启动也不静默重置，
 * 否则已吊销设备会被无声恢复。
 */
export async function createDeviceTokenStore(
  layout: ServerLayout,
  options: DeviceTokenStoreOptions = {},
): Promise<DeviceTokenStore> {
  const now = options.now ?? Date.now;
  let file: DevicesFile;
  try {
    const raw = await readFile(layout.devicesFile, "utf8");
    file = devicesFileSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      file = devicesFileSchema.parse({});
    } else {
      throw new Error(
        `Invalid device store at ${layout.devicesFile}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return new FileDeviceTokenStore(layout, file, now);
}
