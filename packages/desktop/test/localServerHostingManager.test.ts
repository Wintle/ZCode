import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import type {
  CliInvocation,
  LocalServerCliProcessResult,
} from "../src/main/localServerHostingManager.js";

/**
 * 「本机作为被控端」管理器单测：全部经 mock CLI 子进程验证状态解析、
 * 未装服务引导、局域网开关序列、设备吊销与 CLI 缺失的结构化降级。
 */

interface CliCall {
  args: string[];
  timeoutMs: number;
}

function createHarness(options: {
  cliInvocation?: CliInvocation | null;
  run?: (
    invocation: CliInvocation,
    args: string[],
    timeoutMs: number,
  ) => Promise<LocalServerCliProcessResult>;
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}) {
  const calls: CliCall[] = [];
  const resolveCliInvocation = vi.fn(async () =>
    options.cliInvocation === undefined
      ? ({ command: "/home/u/.zcode/server/bin/zcode", prefixArgs: [] } as CliInvocation)
      : options.cliInvocation,
  );
  const runCliProcess = vi.fn(
    async (invocation: CliInvocation, args: string[], timeoutMs: number) => {
      calls.push({ args, timeoutMs });
      if (!options.run) throw new Error("test must provide run()");
      return await options.run(invocation, args, timeoutMs);
    },
  );
  return {
    calls,
    resolveCliInvocation,
    runCliProcess,
    networkInterfaces: options.networkInterfaces ?? {},
  };
}

function okJson(payload: unknown): LocalServerCliProcessResult {
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "", timedOut: false };
}

function failJson(payload: unknown): LocalServerCliProcessResult {
  return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: "", timedOut: false };
}

function stoppedStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    state: "stopped",
    pid: null,
    port: null,
    host: null,
    version: "3.12.0",
    generation: 0,
    startedAt: null,
    lastExitReason: null,
    serviceRegistered: false,
    runningTaskCount: 0,
    crashBudget: { crashCount: 0, nextRestartDelayMs: 1000, exhausted: false },
    updatedAt: 1_700_000_000_000,
    listenHost: null,
    listenPort: null,
    pairingReady: false,
    ...overrides,
  };
}

function readyStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return stoppedStatus({
    state: "ready",
    pid: 4242,
    port: 8737,
    host: "127.0.0.1",
    serviceRegistered: true,
    listenHost: "127.0.0.1",
    listenPort: 8737,
    pairingReady: true,
    ...overrides,
  });
}

async function createManager(harness: {
  calls: CliCall[];
  resolveCliInvocation: ReturnType<typeof vi.fn>;
  runCliProcess: ReturnType<typeof vi.fn>;
  networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}) {
  const { createLocalServerHostingManager } =
    await import("../src/main/localServerHostingManager.js");
  return createLocalServerHostingManager({
    resolveCliInvocation: harness.resolveCliInvocation,
    runCliProcess: harness.runCliProcess,
    listNetworkInterfaces: () => harness.networkInterfaces,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("LocalServerHostingManager.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("解析 status + tokens 为状态投影，只统计 active 设备", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.join(" ") === "serve status --json") {
          return okJson(
            readyStatus({ listenHost: "0.0.0.0", listenPort: 9000, host: "0.0.0.0", port: 9000 }),
          );
        }
        if (args.join(" ") === "serve tokens --json") {
          return okJson([
            { id: "d1", name: "laptop", lastSeenAt: 1, revokedAt: null, status: "active" },
            { id: "d2", name: "phone", lastSeenAt: 2, revokedAt: 3, status: "revoked" },
            { id: "d3", name: "tablet", lastSeenAt: 4, revokedAt: null, status: "active" },
          ]);
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      },
    });
    const manager = await createManager(harness);

    const status = await manager.getStatus();

    expect(status).toMatchObject({
      cliAvailable: true,
      installed: true,
      running: true,
      state: "ready",
      listenHost: "0.0.0.0",
      listenPort: 9000,
      lanEnabled: true,
      pairedDeviceCount: 2,
      serviceRegistered: true,
      version: "3.12.0",
      failure: null,
    });
  });

  it("回环监听标记 lanEnabled=false", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.includes("status")) return okJson(readyStatus());
        return okJson([]);
      },
    });
    const manager = await createManager(harness);

    const status = await manager.getStatus();

    expect(status.lanEnabled).toBe(false);
    expect(status.running).toBe(true);
  });

  it("CLI 缺失时返回结构化 not-installed 态，不抛裸异常", async () => {
    const harness = createHarness({ cliInvocation: null });
    const manager = await createManager(harness);

    const status = await manager.getStatus();

    expect(status.cliAvailable).toBe(false);
    expect(status.failure?.code).toBe("cli-unavailable");
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(harness.runCliProcess).not.toHaveBeenCalled();
  });

  it("tokens 失败时设备数为 null（未知），不伪造 0", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.includes("status")) return okJson(readyStatus());
        return failJson({ ok: false, code: "core-not-ready", error: "not ready" });
      },
    });
    const manager = await createManager(harness);

    const status = await manager.getStatus();

    expect(status.pairedDeviceCount).toBeNull();
    expect(status.failure).toMatchObject({ code: "command-failed", cliCode: "core-not-ready" });
    expect(status.running).toBe(true);
  });

  it("从不安装的机器上 status 为 stopped 且无服务注册 → installed=false", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.includes("status")) return okJson(stoppedStatus());
        return okJson([]);
      },
    });
    const manager = await createManager(harness);

    const status = await manager.getStatus();

    expect(status).toMatchObject({ installed: false, running: false, state: "stopped" });
  });
});

describe("LocalServerHostingManager.setLanEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("已安装且运行中：config set 后重启服务", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        const joined = args.join(" ");
        if (joined === "serve status --json") {
          return okJson(readyStatus({ listenHost: "127.0.0.1", listenPort: 8737 }));
        }
        if (joined === "serve tokens --json") return okJson([]);
        if (joined === "serve config set --host 0.0.0.0 --port 9001 --json") {
          return okJson({ listen: { host: "0.0.0.0", port: 9001 } });
        }
        if (joined === "serve restart --json") {
          return okJson(readyStatus({ listenHost: "0.0.0.0", listenPort: 9001 }));
        }
        throw new Error(`unexpected args: ${joined}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: true, port: 9001 });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.needsInstall).toBe(false);
    expect(result.value.restartRequested).toBe(true);
    expect(harness.calls.map((call) => call.args.join(" "))).toEqual([
      "serve status --json",
      "serve tokens --json",
      "serve config set --host 0.0.0.0 --port 9001 --json",
      "serve restart --json",
      "serve status --json",
      "serve tokens --json",
    ]);
  });

  it("未安装服务：返回 needsInstall 且不做任何写入", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.includes("status")) return okJson(stoppedStatus());
        return okJson([]);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: true, port: 8737 });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.needsInstall).toBe(true);
    expect(result.value.restartRequested).toBe(false);
    expect(harness.calls.some((call) => call.args.includes("config"))).toBe(false);
    expect(harness.calls.some((call) => call.args.includes("restart"))).toBe(false);
  });

  it("关闭局域网监听：写回 127.0.0.1 并重启", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        const joined = args.join(" ");
        if (joined === "serve status --json") {
          return okJson(readyStatus({ listenHost: "0.0.0.0", listenPort: 8737 }));
        }
        if (joined === "serve tokens --json") return okJson([]);
        if (joined === "serve config set --host 127.0.0.1 --json") {
          return okJson({ listen: { host: "127.0.0.1" } });
        }
        if (joined === "serve restart --json") return okJson(readyStatus());
        throw new Error(`unexpected args: ${joined}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: false });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.restartRequested).toBe(true);
    const sequence = harness.calls.map((call) => call.args.join(" "));
    expect(sequence).toContain("serve config set --host 127.0.0.1 --json");
    expect(sequence).toContain("serve restart --json");
  });

  it("已安装但停止：写配置后以 serve --daemon 拉起，而非 restart", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        const joined = args.join(" ");
        if (joined === "serve status --json")
          return okJson(stoppedStatus({ serviceRegistered: true }));
        if (joined === "serve tokens --json") return okJson([]);
        if (joined === "serve config set --host 0.0.0.0 --port 8737 --json") {
          return okJson({ listen: { host: "0.0.0.0", port: 8737 } });
        }
        if (joined === "serve --daemon --host 0.0.0.0 --port 8737 --json") {
          return okJson(readyStatus({ listenHost: "0.0.0.0", listenPort: 8737 }));
        }
        throw new Error(`unexpected args: ${joined}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: true, port: 8737 });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.needsInstall).toBe(false);
    expect(result.value.restartRequested).toBe(false);
    const sequence = harness.calls.map((call) => call.args.join(" "));
    expect(sequence).toContain("serve --daemon --host 0.0.0.0 --port 8737 --json");
    expect(sequence).not.toContain("serve restart --json");
  });

  it("端口越界时拒绝请求，不触达 CLI", async () => {
    const harness = createHarness({});
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: true, port: 0 });

    expect(result).toMatchObject({ ok: false, failure: { code: "invalid-request" } });
    expect(harness.runCliProcess).not.toHaveBeenCalled();
  });

  it("config set 失败时透传 CLI 分类码并停止后续 restart", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        const joined = args.join(" ");
        if (joined === "serve status --json") return okJson(readyStatus());
        if (joined === "serve tokens --json") return okJson([]);
        if (joined.startsWith("serve config set")) {
          return failJson({ ok: false, error: "--port must be an integer between 1 and 65535" });
        }
        throw new Error(`unexpected args: ${joined}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.setLanEnabled({ enabled: true, port: 9001 });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "command-failed", message: expect.stringContaining("--port") },
    });
    expect(harness.calls.some((call) => call.args.includes("restart"))).toBe(false);
  });
});

describe("LocalServerHostingManager pairing and devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePairingCode 透出码与有效期", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        expect(args).toEqual(["serve", "pair", "--json"]);
        return okJson({
          code: "abc123",
          expiresAt: 1_700_000_600_000,
          host: "192.168.1.5",
          port: 8737,
        });
      },
    });
    const manager = await createManager(harness);

    const result = await manager.generatePairingCode();

    expect(result).toEqual({
      ok: true,
      value: { code: "abc123", expiresAt: 1_700_000_600_000, host: "192.168.1.5", port: 8737 },
    });
  });

  it("服务未运行时 pair 失败映射为 server-unavailable", async () => {
    const harness = createHarness({
      run: async () =>
        failJson({ ok: false, error: "ZCode Server is not running; start it first" }),
    });
    const manager = await createManager(harness);

    const result = await manager.generatePairingCode();

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "server-unavailable", message: expect.stringContaining("not running") },
    });
  });

  it("listDevices 返回 CLI 设备条目", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        expect(args).toEqual(["serve", "tokens", "--json"]);
        return okJson([
          { id: "d1", name: "laptop", lastSeenAt: 7, revokedAt: null, status: "active" },
        ]);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.listDevices();

    expect(result).toEqual({
      ok: true,
      value: [{ id: "d1", name: "laptop", lastSeenAt: 7, status: "active" }],
    });
  });

  it("revokeDevice 透传 id，device-not-found 保留 cliCode", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        if (args.join(" ") === "serve tokens revoke d1 --json") return okJson({ revoked: ["d1"] });
        throw new Error(`unexpected args: ${args.join(" ")}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.revokeDevice("d1");

    expect(result).toEqual({ ok: true, value: { revoked: ["d1"] } });

    const missingHarness = createHarness({
      run: async () =>
        failJson({ ok: false, code: "device-not-found", error: "Device x not found" }),
    });
    const missingManager = await createManager(missingHarness);
    const missing = await missingManager.revokeDevice("x");
    expect(missing).toMatchObject({
      ok: false,
      failure: { code: "command-failed", cliCode: "device-not-found" },
    });
  });

  it("非法 deviceId 直接拒绝，不触达 CLI（防参数注入）", async () => {
    const harness = createHarness({});
    const manager = await createManager(harness);

    const result = await manager.revokeDevice("d1; rm -rf /");

    expect(result).toMatchObject({ ok: false, failure: { code: "invalid-request" } });
    expect(harness.runCliProcess).not.toHaveBeenCalled();
  });

  it("revokeAll 调用 tokens revoke --all", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        expect(args).toEqual(["serve", "tokens", "revoke", "--all", "--json"]);
        return okJson({ revoked: ["d1", "d2"] });
      },
    });
    const manager = await createManager(harness);

    const result = await manager.revokeAll();

    expect(result).toEqual({ ok: true, value: { revoked: ["d1", "d2"] } });
  });
});

describe("LocalServerHostingManager.installAndStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("执行 serve --daemon --host 0.0.0.0 --port 并返回最新状态", async () => {
    const harness = createHarness({
      run: async (_invocation, args) => {
        const joined = args.join(" ");
        if (joined === "serve --daemon --host 0.0.0.0 --port 8737 --json") {
          return okJson(readyStatus({ listenHost: "0.0.0.0", listenPort: 8737 }));
        }
        if (joined === "serve status --json") {
          return okJson(readyStatus({ listenHost: "0.0.0.0", listenPort: 8737 }));
        }
        if (joined === "serve tokens --json") return okJson([]);
        throw new Error(`unexpected args: ${joined}`);
      },
    });
    const manager = await createManager(harness);

    const result = await manager.installAndStart({ port: 8737 });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      running: true,
      listenHost: "0.0.0.0",
      listenPort: 8737,
      lanEnabled: true,
    });
    expect(harness.calls[0]?.args).toEqual([
      "serve",
      "--daemon",
      "--host",
      "0.0.0.0",
      "--port",
      "8737",
      "--json",
    ]);
    // daemon 安装路径使用放宽的超时预算（服务注册 + ready 等待）。
    expect(harness.calls[0]?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("端口越界时拒绝请求", async () => {
    const harness = createHarness({});
    const manager = await createManager(harness);

    const result = await manager.installAndStart(70_000);

    expect(result).toMatchObject({ ok: false, failure: { code: "invalid-request" } });
  });
});

describe("LocalServerHostingManager.listLocalAddresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("枚举非回环网卡地址，跳过 internal 与回环", async () => {
    const harness = createHarness({
      networkInterfaces: {
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
          {
            address: "::1",
            netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            family: "IPv6",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "::1/128",
            scopeid: 0,
          },
        ],
        en0: [
          {
            address: "192.168.1.5",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.1.5/24",
          },
          {
            address: "fe80::1",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "fe80::1/64",
            scopeid: 1,
          },
        ],
      },
    });
    const manager = await createManager(harness);

    const addresses = manager.listLocalAddresses();

    expect(addresses).toEqual([
      { address: "192.168.1.5", family: "IPv4" },
      { address: "fe80::1", family: "IPv6" },
    ]);
  });
});
