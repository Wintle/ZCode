import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServiceLogger } from "@zcode/services/node";
import {
  LOCAL_SERVER_DEFAULT_LAN_PORT,
  type LocalServerAddressEntry,
  type LocalServerDeviceEntry,
  type LocalServerHostingFailure,
  type LocalServerHostingOperationResult,
  type LocalServerHostingStatus,
  type LocalServerInstallStartRequest,
  type LocalServerLanEnabledRequest,
  type LocalServerLanToggleResult,
  type LocalServerPairingCode,
  type LocalServerRevokeResult,
} from "@zcode/shared";

/**
 * 「本机作为被控端」管理器（spec：docs/remote/lan-direct-connection.md 被控端界面配置）。
 *
 * 单一所有权：全部能力经 zcode CLI 异步子进程执行（serve status / pair / tokens /
 * tokens revoke / config set / serve --daemon），不在 App 内重写配对、吊销或
 * devices.json 存储逻辑。面板只投影 CLI 返回的事实。
 */

export interface CliInvocation {
  /** 可执行文件（脚本或二进制）。 */
  command: string;
  /** 拼在子命令前的参数（如 node 的入口脚本路径）。 */
  prefixArgs: string[];
  /** Windows 下经 shell 启动 .cmd 启动器时需要。 */
  shell?: boolean;
}

export interface LocalServerCliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LocalServerHostingManagerDeps {
  /** 定位 zcode server CLI；返回 null 表示未安装/不可达（结构化 not-installed 态，不抛裸异常）。 */
  resolveCliInvocation?: () => Promise<CliInvocation | null>;
  runCliProcess?: (
    invocation: CliInvocation,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<LocalServerCliProcessResult>;
  listNetworkInterfaces?: () => NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface LocalServerHostingManager {
  getStatus(): Promise<LocalServerHostingStatus>;
  generatePairingCode(): Promise<LocalServerHostingOperationResult<LocalServerPairingCode>>;
  listDevices(): Promise<LocalServerHostingOperationResult<LocalServerDeviceEntry[]>>;
  revokeDevice(
    deviceId: string,
  ): Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>>;
  revokeAll(): Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>>;
  setLanEnabled(
    request: LocalServerLanEnabledRequest,
  ): Promise<LocalServerHostingOperationResult<LocalServerLanToggleResult>>;
  installAndStart(
    request: LocalServerInstallStartRequest,
  ): Promise<LocalServerHostingOperationResult<LocalServerHostingStatus>>;
  listLocalAddresses(): LocalServerAddressEntry[];
}

// 管理命令走 control socket（CLI 侧内部预算 ~15s）；生命周期命令（restart/daemon）
// 需覆盖 Supervisor 停止宽限、强杀等待与 ready 等待，放宽到分钟级。
const MANAGEMENT_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 60_000;
const DAEMON_INSTALL_TIMEOUT_MS = 120_000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

/** 设备 id 会成为 CLI 参数；只接受 server 生成 id 的字符集，杜绝参数注入。 */
function isValidDeviceId(deviceId: string): boolean {
  const trimmed = deviceId.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && DEVICE_ID_PATTERN.test(trimmed);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return true;
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4);
}

function failure(
  code: LocalServerHostingFailure["code"],
  message: string,
  cliCode?: string,
): LocalServerHostingFailure {
  return { code, message, ...(cliCode ? { cliCode } : {}) };
}

function failureResult(
  code: LocalServerHostingFailure["code"],
  message: string,
  cliCode?: string,
): LocalServerHostingOperationResult<never> {
  return { ok: false, failure: failure(code, message, cliCode) };
}

// ---- CLI 输出解析（结构化校验，损坏输出不静默降级） ----

interface ParsedCliError {
  ok: false;
  code?: string;
  error: string;
}

function parseCliJson(raw: string): unknown {
  return JSON.parse(raw.trim());
}

function asCliError(parsed: unknown): ParsedCliError | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== "string") return null;
  return {
    ok: false,
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    error: record.error,
  };
}

interface CliStatusSnapshot {
  state: string;
  pid: number | null;
  port: number | null;
  host: string | null;
  version: string | null;
  serviceRegistered: boolean;
  listenHost: string | null;
  listenPort: number | null;
}

function parseStatusSnapshot(parsed: unknown): CliStatusSnapshot | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.state !== "string" || record.state.length === 0) return null;
  const readNullableNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const readNullableString = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    state: record.state,
    pid: readNullableNumber(record.pid),
    port: readNullableNumber(record.port),
    host: readNullableString(record.host),
    version: readNullableString(record.version),
    serviceRegistered: record.serviceRegistered === true,
    listenHost: readNullableString(record.listenHost),
    listenPort: readNullableNumber(record.listenPort),
  };
}

const RUNNING_STATES = new Set(["starting", "ready"]);
// 从未安装的机器上 status 回退为 stopped + serviceRegistered=false；
// uninstalled 状态同样视为未安装（安装证据随卸载清除）。
const INSTALLED_STATES = new Set([
  "starting",
  "ready",
  "stopping",
  "stop-failed",
  "updating",
  "crashed",
  "crash-loop-stopped",
]);

function isInstalled(snapshot: CliStatusSnapshot): boolean {
  if (snapshot.state === "uninstalled") return false;
  return snapshot.serviceRegistered || INSTALLED_STATES.has(snapshot.state);
}

function parseDeviceEntries(parsed: unknown): LocalServerDeviceEntry[] | null {
  if (!Array.isArray(parsed)) return null;
  const entries: LocalServerDeviceEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.name !== "string" ||
      typeof record.lastSeenAt !== "number" ||
      (record.status !== "active" && record.status !== "revoked")
    ) {
      return null;
    }
    entries.push({
      id: record.id,
      name: record.name,
      lastSeenAt: record.lastSeenAt,
      status: record.status,
    });
  }
  return entries;
}

// ---- CLI 定位 ----

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 默认 serverRoot，与 zcode-server-cli 的 getDefaultServerDataRoot 保持一致。 */
function defaultServerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_DATA_BASE_DIR?.trim();
  return join(configured || homedir(), ".zcode", "server");
}

/**
 * 定位本机 zcode server CLI。解析顺序（内置路径 → 安装布局 → PATH 兜底）：
 * 1. `ZCODE_SERVER_CLI_COMMAND` 显式覆盖（开发/试验用，沿用 ZCODE_AGENT_SERVER_COMMAND 惯例）；
 * 2. monorepo 开发态：`packages/zcode-server-cli/dist/server-cli.js`（Electron Node 以
 *    ELECTRON_RUN_AS_NODE 执行），缺失时回退 tsx 跑 `src/main.ts`——与 zcodeAgentProcessManager
 *    的 agent CLI 解析顺序一致（dev 改源码立刻生效，不被历史安装抢先匹配）；
 * 3. 已安装 Server 的 stable launcher `<serverRoot>/bin/zcode`（`serve --daemon` 服务注册时写入）；
 * 4. 已安装 Server 的 current release（`current.json` → `<releaseDir>/runtime/{node,server-cli.js}`，
 *    覆盖 stable launcher 缺失但 release 仍完整的情况）；
 * 5. PATH 上的 `zcode`（Windows 为 `zcode.cmd`，经 shell 启动）。
 * 全部缺失返回 null → UI 展示安装引导（可复制命令），不抛裸异常。
 */
export async function resolveLocalServerCliInvocation(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliInvocation | null> {
  const override = env.ZCODE_SERVER_CLI_COMMAND?.trim();
  if (override) return { command: override, prefixArgs: [] };

  const distEntrypoint = findUpward("packages/zcode-server-cli/dist/server-cli.js");
  if (distEntrypoint) {
    return { command: process.execPath, prefixArgs: [distEntrypoint] };
  }
  const srcEntrypoint = findUpward("packages/zcode-server-cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (srcEntrypoint && tsxEntrypoint) {
    return { command: tsxEntrypoint, prefixArgs: [srcEntrypoint] };
  }

  const serverRoot = defaultServerRoot(env);
  const platformIsWindows = process.platform === "win32";
  const stableLauncher = join(serverRoot, "bin", platformIsWindows ? "zcode.cmd" : "zcode");
  if (existsSync(stableLauncher)) {
    return {
      command: stableLauncher,
      prefixArgs: [],
      ...(platformIsWindows ? { shell: true } : {}),
    };
  }

  try {
    const current = JSON.parse(readFileSync(join(serverRoot, "current.json"), "utf8")) as {
      releaseDir?: unknown;
    };
    if (typeof current.releaseDir === "string" && current.releaseDir.length > 0) {
      const runtimeNode = join(
        current.releaseDir,
        "runtime",
        platformIsWindows ? "node.exe" : "node",
      );
      const runtimeCli = join(current.releaseDir, "runtime", "server-cli.js");
      if (existsSync(runtimeNode) && existsSync(runtimeCli)) {
        return { command: runtimeNode, prefixArgs: [runtimeCli] };
      }
    }
  } catch {
    // current.json 缺失或损坏：继续走 PATH 兜底。
  }

  return {
    command: platformIsWindows ? "zcode.cmd" : "zcode",
    prefixArgs: [],
    ...(platformIsWindows ? { shell: true } : {}),
  };
}

function runProcess(
  invocation: CliInvocation,
  args: readonly string[],
  timeoutMs: number,
): Promise<LocalServerCliProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(invocation.shell ? { shell: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: LocalServerCliProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CLI_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CLI_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error: Error) => {
      // spawn 失败（如 ENOENT）：按结构化结果上报，由上层映射 cli-unavailable。
      finish({ exitCode: null, stdout, stderr: error.message, timedOut: false });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function toOperationFailure(
  result: LocalServerCliProcessResult,
  commandLabel: string,
): LocalServerHostingFailure {
  if (result.timedOut) {
    return failure("timeout", `${commandLabel} timed out`);
  }
  if (result.exitCode === null) {
    return failure("cli-unavailable", `${commandLabel} could not be executed: ${result.stderr}`);
  }
  if (result.exitCode !== 0) {
    try {
      const cliError = asCliError(parseCliJson(result.stdout));
      if (cliError) {
        // CLI 的友好错误（toFriendlyManagementError）把 control socket 不可达归一为
        // "not running"；UI 需要把它展示为「服务未运行」而非通用失败。
        if (/not running/iu.test(cliError.error)) {
          return failure("server-unavailable", cliError.error, cliError.code);
        }
        return failure("command-failed", cliError.error, cliError.code);
      }
    } catch {
      // 输出不是 JSON：回落到 stderr 文本。
    }
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    return failure("command-failed", `${commandLabel} failed: ${detail}`);
  }
  return failure("invalid-output", `${commandLabel} produced no parseable output`);
}

export function createLocalServerHostingManager(
  deps: LocalServerHostingManagerDeps = {},
): LocalServerHostingManager {
  const logger =
    deps.logger ?? createServiceLogger("local-server-hosting", { isDebugEnabled: false });
  const resolveCli = deps.resolveCliInvocation ?? (() => resolveLocalServerCliInvocation());
  const runCliProcess = deps.runCliProcess ?? runProcess;
  const listInterfaces = deps.listNetworkInterfaces ?? networkInterfaces;

  async function runCli(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<
    | { ok: true; invocation: CliInvocation; result: LocalServerCliProcessResult }
    | { ok: false; failure: LocalServerHostingFailure }
  > {
    const invocation = await resolveCli();
    if (!invocation) {
      return {
        ok: false,
        failure: failure(
          "cli-unavailable",
          "ZCode server CLI was not found on this computer (checked ZCODE_SERVER_CLI_COMMAND, workspace build, installed server, and PATH)",
        ),
      };
    }
    // 只记录命令形状与退出码；配对码、设备列表等 CLI 输出内容绝不进日志。
    logger.debug(undefined, "[local-server-hosting] run", { command: invocation.command, args });
    const result = await runCliProcess(invocation, args, timeoutMs);
    logger.debug(undefined, "[local-server-hosting] exit", {
      command: invocation.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    return { ok: true, invocation, result };
  }

  async function fetchStatusSnapshot(): Promise<
    { ok: true; snapshot: CliStatusSnapshot } | { ok: false; failure: LocalServerHostingFailure }
  > {
    const outcome = await runCli(["serve", "status", "--json"], MANAGEMENT_TIMEOUT_MS);
    if (!outcome.ok) return outcome;
    if (outcome.result.timedOut || outcome.result.exitCode !== 0) {
      return { ok: false, failure: toOperationFailure(outcome.result, "zcode serve status") };
    }
    let snapshot: CliStatusSnapshot | null = null;
    try {
      snapshot = parseStatusSnapshot(parseCliJson(outcome.result.stdout));
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      return {
        ok: false,
        failure: failure("invalid-output", "zcode serve status returned unparsable JSON"),
      };
    }
    return { ok: true, snapshot };
  }

  async function fetchPairedDeviceCount(): Promise<
    { ok: true; count: number } | { ok: false; failure: LocalServerHostingFailure }
  > {
    const outcome = await runCli(["serve", "tokens", "--json"], MANAGEMENT_TIMEOUT_MS);
    if (!outcome.ok) return outcome;
    if (outcome.result.timedOut || outcome.result.exitCode !== 0) {
      return { ok: false, failure: toOperationFailure(outcome.result, "zcode serve tokens") };
    }
    try {
      const entries = parseDeviceEntries(parseCliJson(outcome.result.stdout));
      if (!entries) {
        return {
          ok: false,
          failure: failure("invalid-output", "zcode serve tokens returned unparsable JSON"),
        };
      }
      return { ok: true, count: entries.filter((entry) => entry.status === "active").length };
    } catch {
      return {
        ok: false,
        failure: failure("invalid-output", "zcode serve tokens returned unparsable JSON"),
      };
    }
  }

  async function composeStatus(): Promise<LocalServerHostingStatus> {
    const statusOutcome = await fetchStatusSnapshot();
    if (!statusOutcome.ok) {
      const cliMissing = statusOutcome.failure.code === "cli-unavailable";
      return {
        cliAvailable: !cliMissing,
        installed: false,
        running: false,
        state: null,
        listenHost: null,
        listenPort: null,
        lanEnabled: false,
        pairedDeviceCount: null,
        serviceRegistered: false,
        version: null,
        failure: statusOutcome.failure,
      };
    }
    const snapshot = statusOutcome.snapshot;
    const listenHost = snapshot.listenHost ?? snapshot.host;
    const listenPort = snapshot.listenPort ?? snapshot.port;
    const deviceOutcome = await fetchPairedDeviceCount();
    return {
      cliAvailable: true,
      installed: isInstalled(snapshot),
      running: RUNNING_STATES.has(snapshot.state),
      state: snapshot.state,
      listenHost,
      listenPort,
      lanEnabled: listenHost !== null && !isLoopbackHost(listenHost),
      pairedDeviceCount: deviceOutcome.ok ? deviceOutcome.count : null,
      serviceRegistered: snapshot.serviceRegistered,
      version: snapshot.version,
      failure: deviceOutcome.ok ? null : deviceOutcome.failure,
    };
  }

  async function runManagementJson(
    args: readonly string[],
    commandLabel: string,
  ): Promise<{ ok: true; parsed: unknown } | { ok: false; failure: LocalServerHostingFailure }> {
    const outcome = await runCli(args, MANAGEMENT_TIMEOUT_MS);
    if (!outcome.ok) return outcome;
    if (outcome.result.timedOut || outcome.result.exitCode !== 0) {
      return { ok: false, failure: toOperationFailure(outcome.result, commandLabel) };
    }
    try {
      return { ok: true, parsed: parseCliJson(outcome.result.stdout) };
    } catch {
      return {
        ok: false,
        failure: failure("invalid-output", `${commandLabel} returned unparsable JSON`),
      };
    }
  }

  return {
    async getStatus(): Promise<LocalServerHostingStatus> {
      return await composeStatus();
    },

    async generatePairingCode(): Promise<
      LocalServerHostingOperationResult<LocalServerPairingCode>
    > {
      // 配对码只经返回值交给 UI 展示，绝不写日志。
      const outcome = await runManagementJson(["serve", "pair", "--json"], "zcode serve pair");
      if (!outcome.ok) return outcome;
      const parsed = outcome.parsed;
      if (!parsed || typeof parsed !== "object") {
        return failureResult("invalid-output", "zcode serve pair returned unparsable JSON");
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.code !== "string" ||
        record.code.length === 0 ||
        typeof record.expiresAt !== "number" ||
        typeof record.host !== "string" ||
        record.host.length === 0 ||
        typeof record.port !== "number"
      ) {
        return failureResult("invalid-output", "zcode serve pair returned an incomplete payload");
      }
      return {
        ok: true,
        value: {
          code: record.code,
          expiresAt: record.expiresAt,
          host: record.host,
          port: record.port,
        },
      };
    },

    async listDevices(): Promise<LocalServerHostingOperationResult<LocalServerDeviceEntry[]>> {
      const outcome = await runManagementJson(["serve", "tokens", "--json"], "zcode serve tokens");
      if (!outcome.ok) return outcome;
      const entries = parseDeviceEntries(outcome.parsed);
      if (!entries) {
        return failureResult("invalid-output", "zcode serve tokens returned unparsable JSON");
      }
      return { ok: true, value: entries };
    },

    async revokeDevice(
      deviceId: string,
    ): Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>> {
      if (!isValidDeviceId(deviceId)) {
        return failureResult("invalid-request", "deviceId contains unsupported characters");
      }
      const outcome = await runManagementJson(
        ["serve", "tokens", "revoke", deviceId.trim(), "--json"],
        "zcode serve tokens revoke",
      );
      return toRevokeResult(outcome);
    },

    async revokeAll(): Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>> {
      const outcome = await runManagementJson(
        ["serve", "tokens", "revoke", "--all", "--json"],
        "zcode serve tokens revoke --all",
      );
      return toRevokeResult(outcome);
    },

    async setLanEnabled(
      request: LocalServerLanEnabledRequest,
    ): Promise<LocalServerHostingOperationResult<LocalServerLanToggleResult>> {
      const port = request.port ?? LOCAL_SERVER_DEFAULT_LAN_PORT;
      if (request.enabled && !isValidPort(port)) {
        return failureResult("invalid-request", `port must be an integer between 1 and 65535`);
      }

      const status = await composeStatus();
      if (!status.cliAvailable || (status.state === null && status.failure)) {
        // CLI 缺失或 status 查询本身失败：不能把「查询失败」误判成「未安装」。
        return {
          ok: false,
          failure: status.failure ?? failure("cli-unavailable", "ZCode server CLI is unavailable"),
        };
      }
      if (request.enabled && !status.installed) {
        // 规格：未安装服务 → 不写任何配置，交由 UI 弹确认后走 installAndStart。
        return {
          ok: true,
          value: { needsInstall: true, restartRequested: false, status },
        };
      }

      const configArgs = request.enabled
        ? ["serve", "config", "set", "--host", "0.0.0.0", "--port", String(port), "--json"]
        : ["serve", "config", "set", "--host", "127.0.0.1", "--json"];
      const configOutcome = await runManagementJson(configArgs, "zcode serve config set");
      if (!configOutcome.ok) return configOutcome;
      logger.info(undefined, "[local-server-hosting] listen config updated", {
        enabled: request.enabled,
        ...(request.enabled ? { port } : {}),
      });

      let restartRequested = false;
      if (status.running) {
        // 已装且运行中：写配置后重启服务（规格语义）。
        const restartOutcome = await runCli(["serve", "restart", "--json"], RESTART_TIMEOUT_MS);
        if (!restartOutcome.ok) return restartOutcome;
        if (restartOutcome.result.timedOut || restartOutcome.result.exitCode !== 0) {
          return toOperationFailureResult(
            toOperationFailure(restartOutcome.result, "zcode serve restart"),
          );
        }
        restartRequested = true;
      } else if (request.enabled) {
        // 已装但当前停止：无法 restart（control socket 不在），改以 daemon 入口拉起已注册服务。
        const startOutcome = await runCli(
          ["serve", "--daemon", "--host", "0.0.0.0", "--port", String(port), "--json"],
          DAEMON_INSTALL_TIMEOUT_MS,
        );
        if (!startOutcome.ok) return startOutcome;
        if (startOutcome.result.timedOut || startOutcome.result.exitCode !== 0) {
          return toOperationFailureResult(
            toOperationFailure(startOutcome.result, "zcode serve --daemon"),
          );
        }
      }

      const refreshed = await composeStatus();
      return {
        ok: true,
        value: { needsInstall: false, restartRequested, status: refreshed },
      };
    },

    async installAndStart(
      request: LocalServerInstallStartRequest,
    ): Promise<LocalServerHostingOperationResult<LocalServerHostingStatus>> {
      if (!isValidPort(request.port)) {
        return failureResult("invalid-request", "port must be an integer between 1 and 65535");
      }
      // 注册系统服务是显式信任动作：仅在 UI 确认后调用。
      const outcome = await runCli(
        ["serve", "--daemon", "--host", "0.0.0.0", "--port", String(request.port), "--json"],
        DAEMON_INSTALL_TIMEOUT_MS,
      );
      if (!outcome.ok) return outcome;
      if (outcome.result.timedOut || outcome.result.exitCode !== 0) {
        return toOperationFailureResult(toOperationFailure(outcome.result, "zcode serve --daemon"));
      }
      logger.info(undefined, "[local-server-hosting] server installed and started", {
        port: request.port,
      });
      return { ok: true, value: await composeStatus() };
    },

    listLocalAddresses(): LocalServerAddressEntry[] {
      const entries: LocalServerAddressEntry[] = [];
      const interfaces = listInterfaces() ?? {};
      for (const addresses of Object.values(interfaces)) {
        for (const address of addresses ?? []) {
          if (address.internal) continue;
          entries.push({
            address: address.address,
            // Node 的 NetworkInterfaceInfo.family 类型是字符串，但部分老 Node 运行时返回数字 6/4；
            // 以运行时值兜底判断，避免 IPv6 地址被误标为 IPv4。
            family:
              address.family === "IPv6" || (address.family as unknown) === 6 ? "IPv6" : "IPv4",
          });
        }
      }
      return entries;
    },
  };
}

function toRevokeResult(
  outcome: { ok: true; parsed: unknown } | { ok: false; failure: LocalServerHostingFailure },
): LocalServerHostingOperationResult<LocalServerRevokeResult> {
  if (!outcome.ok) return outcome;
  const parsed = outcome.parsed;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).revoked) ||
    (parsed as { revoked: unknown[] }).revoked.some((id) => typeof id !== "string")
  ) {
    return failureResult("invalid-output", "zcode serve tokens revoke returned unparsable JSON");
  }
  return { ok: true, value: { revoked: (parsed as { revoked: string[] }).revoked } };
}

function toOperationFailureResult(
  fail: LocalServerHostingFailure,
): LocalServerHostingOperationResult<never> {
  return { ok: false, failure: fail };
}
