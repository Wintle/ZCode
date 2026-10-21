import { describe, expect, it } from "vitest";
import {
  authErrorSchema,
  controlRequestSchema,
  controlResponseSchema,
  coreCommandSchema,
  coreMessageSchema,
  deviceListResultSchema,
  pairErrorSchema,
  pairRequestSchema,
  pairSuccessSchema,
  releaseCatalogSchema,
  releaseManifestSchema,
  revokeDevicesResultSchema,
  runtimeIdentitySchema,
  serverStatusSchema,
  serveConfigSetResultSchema,
  serveConfigShowResultSchema,
  servePairResultSchema,
  createStoppedServerStatus,
} from "../src/contracts.js";

describe("R2 control contract", () => {
  it("rejects unknown lifecycle commands and accepts JSONL-safe requests", () => {
    expect(controlRequestSchema.safeParse({ id: "1", command: "status" }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ id: "1", command: "runtime-identity" }).success).toBe(
      true,
    );
    expect(controlRequestSchema.safeParse({ id: "1", command: "kill-pid", pid: 4 }).success).toBe(
      false,
    );
    expect(
      controlRequestSchema.safeParse({
        id: "1",
        command: "confirm-uninstall",
        confirmation: "DELETE",
      }).success,
    ).toBe(true);
  });

  it("keeps runtime identity separate from the persisted status contract", () => {
    expect(
      runtimeIdentitySchema.parse({
        supervisorVersion: "3.9.0",
        supervisorReleaseId: "release-b",
        activeReleaseVersion: "3.9.0",
        activeReleaseId: "release-b",
        coreVersion: "3.9.0",
        coreReleaseId: "release-b",
      }),
    ).toMatchObject({ supervisorReleaseId: "release-b", coreReleaseId: "release-b" });
    expect(
      serverStatusSchema.safeParse({
        state: "ready",
        pid: 42,
        port: 38123,
        host: "127.0.0.1",
        version: "3.9.0",
        generation: 1,
        serviceRegistered: false,
        runningTaskCount: 0,
        crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
        updatedAt: 2,
        supervisorReleaseId: "release-b",
      }).success,
    ).toBe(false);
  });

  it("accepts a ready status inside a control response", () => {
    const parsed = serverStatusSchema.parse({
      state: "ready",
      pid: 42,
      port: 38123,
      host: "127.0.0.1",
      version: "3.8.0",
      generation: 1,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { windowStartedAt: 1, crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: 2,
    });
    expect(controlResponseSchema.parse({ id: "1", ok: true, result: parsed }).ok).toBe(true);
  });

  it("rejects release versions that could escape the releases directory", () => {
    expect(
      releaseManifestSchema.safeParse({ version: "../escape", releaseDir: "/tmp/release" }).success,
    ).toBe(false);
    expect(
      releaseCatalogSchema.safeParse({
        schemaVersion: 1,
        releases: [
          {
            version: "3.8.0/evil",
            target: "linux-x64",
            archiveUrl: "https://example.test/release.tar.gz",
            archiveSha256: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("builds a complete stopped snapshot for offline CLI fallbacks", () => {
    const status = createStoppedServerStatus("3.8.0", { serviceRegistered: true, now: 42 });
    expect(status).toEqual(
      expect.objectContaining({
        state: "stopped",
        pid: null,
        port: null,
        host: null,
        version: "3.8.0",
        generation: 0,
        startedAt: null,
        lastExitReason: null,
        serviceRegistered: true,
        runningTaskCount: 0,
        updatedAt: 42,
      }),
    );
    expect(serverStatusSchema.parse(status)).toEqual(status);
  });
});

describe("LAN direct connection contracts (P1)", () => {
  const legacyStatus = {
    state: "ready",
    pid: 42,
    port: 38123,
    host: "127.0.0.1",
    version: "3.8.0",
    generation: 1,
    serviceRegistered: false,
    runningTaskCount: 0,
    crashBudget: { windowStartedAt: 1, crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
    updatedAt: 2,
  };

  it("keeps old status.json readable and fills listen/pairing defaults", () => {
    const parsed = serverStatusSchema.parse(legacyStatus);
    expect(parsed.listenHost).toBeNull();
    expect(parsed.listenPort).toBeNull();
    expect(parsed.pairingReady).toBe(false);

    const listening = serverStatusSchema.parse({
      ...legacyStatus,
      listenHost: "192.168.1.5",
      listenPort: 8737,
      pairingReady: true,
    });
    expect(listening).toMatchObject({
      listenHost: "192.168.1.5",
      listenPort: 8737,
      pairingReady: true,
    });
    // 未知字段仍然拒绝（strict 契约不放松）。
    expect(serverStatusSchema.safeParse({ ...legacyStatus, extra: 1 }).success).toBe(false);
    // stopped 快照也携带可选字段，保证 --json 输出结构稳定。
    expect(createStoppedServerStatus("3.8.0")).toMatchObject({
      listenHost: null,
      listenPort: null,
      pairingReady: false,
    });
  });

  it("accepts the LAN management control commands and Core command-result round-trip", () => {
    expect(controlRequestSchema.safeParse({ id: "1", command: "pair" }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ id: "1", command: "list-devices" }).success).toBe(true);
    expect(
      controlRequestSchema.safeParse({
        id: "1",
        command: "revoke-devices",
        deviceId: "d1",
      }).success,
    ).toBe(true);
    expect(
      controlRequestSchema.safeParse({ id: "1", command: "revoke-devices", all: true }).success,
    ).toBe(true);

    expect(coreCommandSchema.safeParse({ command: "shutdown" }).success).toBe(true);
    expect(coreCommandSchema.safeParse({ command: "pair", id: "c1" }).success).toBe(true);
    expect(coreCommandSchema.safeParse({ command: "list-devices", id: "c2" }).success).toBe(true);
    expect(
      coreCommandSchema.safeParse({ command: "revoke-devices", id: "c3", all: true }).success,
    ).toBe(true);
    expect(coreCommandSchema.safeParse({ command: "pair" }).success).toBe(false);

    // 旧 Core 的 ready（无 listen 字段）与新 ready 都必须能解析。
    expect(
      coreMessageSchema.safeParse({
        type: "ready",
        host: "127.0.0.1",
        port: 1,
        version: "1",
        generation: 1,
      }).success,
    ).toBe(true);
    expect(
      coreMessageSchema.safeParse({
        type: "ready",
        host: "127.0.0.1",
        port: 1,
        version: "1",
        generation: 1,
        listenHost: "0.0.0.0",
        listenPort: 8737,
        pairingReady: true,
        pairedDeviceCount: 2,
      }).success,
    ).toBe(true);
    expect(
      coreMessageSchema.safeParse({
        type: "command-result",
        id: "c1",
        ok: true,
        result: { revoked: ["d1"] },
      }).success,
    ).toBe(true);
    expect(
      coreMessageSchema.safeParse({
        type: "command-result",
        id: "c1",
        ok: false,
        error: { code: "device-not-found", message: "nope" },
      }).success,
    ).toBe(true);
    expect(
      coreMessageSchema.safeParse({ type: "command-result", id: "c1", ok: false }).success,
    ).toBe(true);
  });

  it("pins the /api/pair and auth 401 wire contracts", () => {
    expect(pairRequestSchema.safeParse({ code: "0123456789abcdef" }).success).toBe(true);
    expect(pairRequestSchema.safeParse({}).success).toBe(false);
    expect(pairSuccessSchema.safeParse({ deviceToken: "t", serverId: "s" }).success).toBe(true);
    expect(pairErrorSchema.safeParse({ error: "bad" }).success).toBe(true);
    expect(pairErrorSchema.safeParse({ error: "bad", code: "pairing-code-invalid" }).success).toBe(
      true,
    );
    expect(pairErrorSchema.safeParse({ error: "bad", code: "not-a-pairing-code" }).success).toBe(
      false,
    );
    expect(authErrorSchema.safeParse({ error: "x", code: "auth-required" }).success).toBe(true);
    expect(authErrorSchema.safeParse({ error: "x", code: "device-revoked" }).success).toBe(true);
    expect(authErrorSchema.safeParse({ error: "x", code: "other" }).success).toBe(false);

    expect(
      servePairResultSchema.safeParse({
        code: "0123456789abcdef",
        expiresAt: 1,
        host: "192.168.1.5",
        port: 8737,
      }).success,
    ).toBe(true);
    expect(
      deviceListResultSchema.safeParse({
        devices: [
          {
            id: "d1",
            name: "laptop",
            lastSeenAt: 1,
            revokedAt: null,
            status: "active",
          },
        ],
      }).success,
    ).toBe(true);
    expect(revokeDevicesResultSchema.safeParse({ revoked: ["d1"] }).success).toBe(true);
    expect(revokeDevicesResultSchema.safeParse({}).success).toBe(false);
  });

  it("pins the serve config set/show JSON output shapes", () => {
    expect(
      serveConfigSetResultSchema.safeParse({ listen: { host: "0.0.0.0", port: 8737 } }).success,
    ).toBe(true);
    // 未配置端口的回环结果省略 port；host 为空与缺 listen 块都必须拒绝。
    expect(serveConfigSetResultSchema.safeParse({ listen: { host: "127.0.0.1" } }).success).toBe(
      true,
    );
    expect(serveConfigSetResultSchema.safeParse({ listen: { host: "" } }).success).toBe(false);
    expect(serveConfigSetResultSchema.safeParse({ listen: { port: 8737 } }).success).toBe(false);
    expect(serveConfigSetResultSchema.safeParse({}).success).toBe(false);
    expect(
      serveConfigSetResultSchema.safeParse({ listen: { host: "0.0.0.0", port: 8737 }, extra: 1 })
        .success,
    ).toBe(false);

    expect(
      serveConfigShowResultSchema.safeParse({
        listen: { host: "0.0.0.0", port: 8737 },
        source: "config",
      }).success,
    ).toBe(true);
    expect(
      serveConfigShowResultSchema.safeParse({ listen: { host: "127.0.0.1" }, source: "default" })
        .success,
    ).toBe(true);
    // show 不读 CLI/env 层，来源只允许配置文件或默认值。
    expect(
      serveConfigShowResultSchema.safeParse({ listen: { host: "127.0.0.1" }, source: "env" })
        .success,
    ).toBe(false);
    expect(serveConfigShowResultSchema.safeParse({ listen: { host: "127.0.0.1" } }).success).toBe(
      false,
    );
  });
});
