import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_MS,
  isLoopbackAddress,
  isLoopbackHost,
  isWildcardHost,
} from "../src/contracts.js";
import { createPairingStore } from "../src/server-core/hostCapability.js";
import { createDeviceTokenStore } from "../src/server-core/ingressToken.js";
import {
  readServerConfig,
  resolveListenTarget,
  resolveServerLayout,
  writeServerConfig,
} from "../src/runtime/paths.js";

async function createLayout(): Promise<ReturnType<typeof resolveServerLayout>> {
  const root = await mkdtemp(join(tmpdir(), "zcode-lan-pairing-"));
  return resolveServerLayout(join(root, "server"));
}

describe("pairing code lifecycle", () => {
  it("issues 64-bit case-insensitive codes with a 10 minute TTL and one-time consumption", () => {
    let now = 1_000;
    const store = createPairingStore({ now: () => now });

    const issued = store.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // ≥40 bit 熵：默认码为 16 位 hex（64 bit），展示归一为小写。
    expect(issued.code).toMatch(/^[0-9a-f]{16}$/u);
    expect(issued.expiresAt).toBe(now + PAIRING_CODE_TTL_MS);
    // 大小写不敏感消费。
    expect(store.consume(issued.code.toUpperCase())).toEqual({ ok: true });
    // 一次性：消费后重放是 invalid 而不是 expired。
    expect(store.consume(issued.code)).toMatchObject({ ok: false, code: "pairing-code-invalid" });

    const second = store.issue();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    now += PAIRING_CODE_TTL_MS;
    expect(store.consume(second.code)).toMatchObject({ ok: false, code: "pairing-code-expired" });
  });

  it("caps concurrent unconsumed codes at 3", () => {
    const store = createPairingStore({ now: () => 0 });
    expect(store.issue().ok).toBe(true);
    expect(store.issue().ok).toBe(true);
    expect(store.issue().ok).toBe(true);
    expect(store.issue()).toMatchObject({ ok: false, code: "pairing-code-limit" });
  });

  it("freezes pairing after 5 failed attempts within a minute and recovers afterwards", () => {
    let now = 10_000;
    const store = createPairingStore({ now: () => now });
    const wrongCode = "ffffffffffffffff";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(store.consume(wrongCode)).toMatchObject({
        ok: false,
        code: "pairing-code-invalid",
      });
    }
    // 冻结期间：既拒绝继续尝试，也拒绝生成新码。
    expect(store.consume(wrongCode)).toMatchObject({ ok: false, code: "pairing-rate-limited" });
    expect(store.issue()).toMatchObject({ ok: false, code: "pairing-rate-limited" });
    expect(store.isFrozen()).toBe(true);

    // 窗口滑过之后自动解冻，合法码恢复可用。
    now += 61_000;
    expect(store.isFrozen()).toBe(false);
    const issued = store.issue();
    expect(issued.ok).toBe(true);
    if (issued.ok) expect(store.consume(issued.code)).toEqual({ ok: true });
  });

  it("resets the failure window after a successful pairing", () => {
    let now = 0;
    const store = createPairingStore({ now: () => now });
    for (let attempt = 0; attempt < 4; attempt++) {
      store.consume("0000000000000000");
    }
    expect(store.isFrozen()).toBe(false);
    const issued = store.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(store.consume(issued.code)).toEqual({ ok: true });
    // 成功配对清空"连续错误"计数：再错 4 次仍不应冻结。
    for (let attempt = 0; attempt < 4; attempt++) {
      now += 1;
      store.consume("0000000000000000");
    }
    expect(store.isFrozen()).toBe(false);
    now += 1;
    store.consume("0000000000000000");
    expect(store.isFrozen()).toBe(true);
  });
});

describe("device token store", () => {
  it("issues ≥32-byte tokens, persists only hashes, and keeps them valid across restarts until revoked", async () => {
    const layout = await createLayout();
    const store = await createDeviceTokenStore(layout);
    expect(store.serverId).toBeNull();

    const { deviceToken, device } = await store.issue({ name: "laptop" });
    expect(Buffer.from(deviceToken, "base64url").length).toBeGreaterThanOrEqual(32);
    const raw = await readFile(layout.devicesFile, "utf8");
    expect(raw).not.toContain(deviceToken);
    expect(raw).toContain(createHash("sha256").update(deviceToken, "utf8").digest("hex"));
    expect(JSON.parse(raw).devices[0]).toMatchObject({ id: device.id, name: "laptop" });
    if (process.platform !== "win32") {
      expect((await stat(layout.devicesFile)).mode & 0o777).toBe(0o600);
    }

    // 重启（重新打开存储）后凭据仍然有效：设备 Token 不参与启动轮换。
    const restarted = await createDeviceTokenStore(layout);
    expect(restarted.verify(deviceToken)).toEqual({ status: "valid", deviceId: device.id });

    await restarted.revoke(device.id);
    // 吊销立即生效，且重启后依然保持吊销状态。
    expect(restarted.verify(deviceToken)).toEqual({ status: "revoked" });
    const afterRestart = await createDeviceTokenStore(layout);
    expect(afterRestart.verify(deviceToken)).toEqual({ status: "revoked" });
    expect(afterRestart.verify("some-other-token-value")).toEqual({ status: "invalid" });
    expect(afterRestart.verify(undefined)).toEqual({ status: "invalid" });
  });

  it("persists the installation-level serverId on first pairing and keeps it stable", async () => {
    const layout = await createLayout();
    const store = await createDeviceTokenStore(layout);
    await expect(store.ensureServerId("server-installation-id")).resolves.toBe(
      "server-installation-id",
    );
    // 幂等：已持久化后不被后续 preferred 值覆盖。
    await expect(store.ensureServerId("other-id")).resolves.toBe("server-installation-id");
    const reopened = await createDeviceTokenStore(layout);
    expect(reopened.serverId).toBe("server-installation-id");
  });

  it("enforces the 16 active device cap and admits new devices after revocation", async () => {
    const layout = await createLayout();
    const store = await createDeviceTokenStore(layout);
    const first = await store.issue();
    for (let index = 1; index < 16; index++) await store.issue();
    expect(store.activeCount()).toBe(16);
    await expect(store.issue()).rejects.toThrow(/device limit/i);
    await store.revoke(first.device.id);
    await expect(store.issue()).resolves.toMatchObject({ device: { revokedAt: null } });
  });

  it("throttles lastSeenAt writes to at most one per minute and flushes on demand", async () => {
    const layout = await createLayout();
    let now = 1_000_000;
    const store = await createDeviceTokenStore(layout, { now: () => now });
    const { deviceToken } = await store.issue();

    // 刚打开的节流窗口内：内存刷新但不落盘。
    now += 10_000;
    expect(store.verify(deviceToken).status).toBe("valid");
    expect(JSON.parse(await readFile(layout.devicesFile, "utf8")).devices[0].lastSeenAt).toBe(
      1_000_000,
    );

    // 距上次写盘 ≥1 分钟：下一次校验立即落盘（写盘在途，flush 仅同步该写入，不新增写盘）。
    now += 60_000;
    expect(store.verify(deviceToken).status).toBe("valid");
    await store.flush();
    expect(JSON.parse(await readFile(layout.devicesFile, "utf8")).devices[0].lastSeenAt).toBe(now);

    // 再次落在节流窗口内，由 flush（shutdown 路径）兜底写盘。
    now += 5_000;
    expect(store.verify(deviceToken).status).toBe("valid");
    await store.flush();
    expect(JSON.parse(await readFile(layout.devicesFile, "utf8")).devices[0].lastSeenAt).toBe(now);
  });

  it("lists devices without exposing token material", async () => {
    const layout = await createLayout();
    const store = await createDeviceTokenStore(layout);
    const active = await store.issue({ name: "desktop" });
    const revoked = await store.issue({ name: "phone" });
    await store.revoke(revoked.device.id);

    const entries = store.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "id",
        "lastSeenAt",
        "name",
        "revokedAt",
        "status",
      ]);
    }
    expect(entries.find((entry) => entry.id === active.device.id)?.status).toBe("active");
    expect(entries.find((entry) => entry.id === revoked.device.id)?.status).toBe("revoked");
  });

  it("fails closed on a corrupt devices.json instead of silently resetting revocations", async () => {
    const layout = await createLayout();
    await mkdir(layout.serverRoot, { recursive: true });
    await writeFile(layout.devicesFile, "{broken", "utf8");
    await expect(createDeviceTokenStore(layout)).rejects.toThrow(/Invalid device store/u);
  });
});

describe("listen configuration", () => {
  it("applies CLI > config > default and fails fast for a non-loopback host without an explicit port", () => {
    expect(resolveListenTarget({}, null)).toEqual({ host: "127.0.0.1" });
    expect(resolveListenTarget({ host: "127.0.0.1", port: 0 }, null)).toEqual({
      host: "127.0.0.1",
      port: 0,
    });

    const config = { listen: { host: "192.168.1.5", port: 8737 } };
    expect(resolveListenTarget({}, config)).toEqual({ host: "192.168.1.5", port: 8737 });
    // CLI 覆盖 host、沿用配置里的 port；反之亦然。
    expect(resolveListenTarget({ host: "10.0.0.9" }, config)).toEqual({
      host: "10.0.0.9",
      port: 8737,
    });
    expect(resolveListenTarget({ port: 9000 }, config)).toEqual({
      host: "192.168.1.5",
      port: 9000,
    });

    // 非回环缺端口 / port 0（动态端口）都必须 fail-fast。
    expect(() => resolveListenTarget({ host: "0.0.0.0" }, null)).toThrow(/explicit --port/u);
    expect(() => resolveListenTarget({ host: "0.0.0.0", port: 0 }, null)).toThrow(
      /explicit --port/u,
    );
    expect(() => resolveListenTarget({ host: "0.0.0.0" }, { listen: { port: 0 } })).toThrow(
      /explicit --port/u,
    );
    // 配置文件提供端口即可满足非回环监听。
    expect(resolveListenTarget({ host: "0.0.0.0" }, { listen: { port: 8737 } })).toEqual({
      host: "0.0.0.0",
      port: 8737,
    });
  });

  it("round-trips server-config.json atomically and rejects corrupt content", async () => {
    const layout = await createLayout();
    await expect(readServerConfig(layout)).resolves.toBeNull();

    await writeServerConfig(layout, { listen: { host: "0.0.0.0", port: 8737 } });
    await expect(readServerConfig(layout)).resolves.toEqual({
      listen: { host: "0.0.0.0", port: 8737 },
    });
    if (process.platform !== "win32") {
      expect((await stat(layout.serverConfigFile)).mode & 0o777).toBe(0o600);
    }

    await writeFile(layout.serverConfigFile, "{broken", "utf8");
    await expect(readServerConfig(layout)).rejects.toThrow(/Invalid server config/u);
  });

  it("classifies loopback and wildcard addresses for listener and pairing decisions", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.53")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);

    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);

    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.7")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
