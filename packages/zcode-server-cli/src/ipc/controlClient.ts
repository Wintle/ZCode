import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  CORE_COMMAND_TIMEOUT_MS,
  controlResponseSchema,
  deviceListResultSchema,
  revokeDevicesResultSchema,
  servePairResultSchema,
  type ControlRequest,
  type DeviceListEntry,
  type ServePairResult,
} from "../contracts.js";
import { createDeviceTokenStore } from "../server-core/ingressToken.js";
import type { ServerLayout } from "../runtime/paths.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

// Omit 不对 union 分发：直接 Omit<ControlRequest, "id"> 会丢掉 confirmation/force 等
// 变体字段，调用方无法以字面量构造合法请求。用分发式 Omit 保留每个命令的完整形状。
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ControlRequestInput = DistributedOmit<ControlRequest, "id">;

export async function requestControl(
  endpoint: string,
  request: ControlRequestInput,
  timeoutMs = 10_000,
): Promise<unknown> {
  const id = randomUUID();
  const socket = connect(endpoint);
  const decoder = new JsonLineDecoder();
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Supervisor control request timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk: string) => {
      try {
        const response = decoder.push(chunk)[0];
        if (response === undefined) return;
        const parsed = controlResponseSchema.parse(response);
        if (parsed.id !== id) return;
        clearTimeout(timeout);
        socket.end();
        if (parsed.ok) resolve(parsed.result);
        else
          reject(
            new ControlRequestError(
              parsed.error?.code ?? "request-failed",
              parsed.error?.message ?? "Supervisor request failed",
              parsed.error?.retryable,
            ),
          );
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });
    socket.on("connect", () => socket.write(encodeJsonLine({ ...request, id })));
  });
}

// ---- `zcode serve pair` / `serve tokens` 管理命令 ----
// 这些命令只经既有 control socket 触达 Supervisor、再由其 IPC 转发到 Core，
// 不为 CLI 新开第二条管理通道；server 已停止时 tokens 的读/吊销回退为直接操作 devices.json。

/** 超时需覆盖 Supervisor 的 CORE_COMMAND_TIMEOUT_MS 转发等待，否则客户端先于 supervisor 报错。 */
const MANAGEMENT_COMMAND_TIMEOUT_MS = CORE_COMMAND_TIMEOUT_MS + 5_000;

export function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL";
}

export interface ServeCommandIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
}

const writeLine = (io: ServeCommandIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

function toFriendlyManagementError(error: unknown): Error {
  if (error instanceof Error && isControlEndpointUnavailable(error)) {
    return new Error("ZCode Server is not running; start it with `zcode serve` first");
  }
  if (error instanceof ControlRequestError && error.code === "core-not-ready") {
    return new Error("Server Core is not ready yet; try again in a moment");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function reportManagementError(io: ServeCommandIO, json: boolean, error: unknown): number {
  const friendly = toFriendlyManagementError(error);
  if (json) {
    const code = error instanceof ControlRequestError ? error.code : undefined;
    writeLine(io, { ok: false, ...(code ? { code } : {}), error: friendly.message });
  } else {
    io.stderr?.write(`${friendly.message}\n`);
  }
  return 1;
}

function formatPairBlock(result: ServePairResult): string {
  const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60_000));
  return [
    `Address: ${result.host}`,
    `Port: ${result.port}`,
    `Pairing code: ${result.code}`,
    `Valid until: ${new Date(result.expiresAt).toISOString()} (~${minutes} minutes)`,
  ].join("\n");
}

export async function runServePairCommand(
  io: ServeCommandIO,
  json: boolean,
  layout: ServerLayout,
): Promise<number> {
  try {
    const raw = await requestControl(
      layout.controlEndpoint,
      { command: "pair" },
      MANAGEMENT_COMMAND_TIMEOUT_MS,
    );
    const result = servePairResultSchema.parse(raw);
    if (json) writeLine(io, result);
    else writeLine(io, formatPairBlock(result));
    return 0;
  } catch (error) {
    return reportManagementError(io, json, error);
  }
}

function formatDeviceTable(devices: DeviceListEntry[]): string {
  if (devices.length === 0) return "No paired devices";
  const header = "ID\tNAME\tLAST SEEN\tSTATUS";
  const rows = devices.map(
    (device) =>
      `${device.id}\t${device.name}\t${new Date(device.lastSeenAt).toISOString()}\t${device.status}`,
  );
  return [header, ...rows].join("\n");
}

async function loadDeviceEntries(layout: ServerLayout): Promise<DeviceListEntry[]> {
  try {
    const raw = await requestControl(
      layout.controlEndpoint,
      { command: "list-devices" },
      MANAGEMENT_COMMAND_TIMEOUT_MS,
    );
    return deviceListResultSchema.parse(raw).devices;
  } catch (error) {
    if (isControlEndpointUnavailable(error)) {
      const store = await createDeviceTokenStore(layout);
      return store.list();
    }
    throw error;
  }
}

type RevokeScope = { all: true; deviceId?: undefined } | { all?: undefined; deviceId: string };

function parseRevokeScope(args: readonly string[]): RevokeScope {
  if (args.length === 1 && args[0] === "--all") return { all: true };
  if (args.length === 1 && args[0] && !args[0].startsWith("--")) return { deviceId: args[0] };
  throw new Error("usage: zcode serve tokens revoke <id> | --all");
}

async function runServeTokensRevokeCommand(
  args: readonly string[],
  io: ServeCommandIO,
  json: boolean,
  layout: ServerLayout,
): Promise<number> {
  const scope = parseRevokeScope(args);
  let revoked: string[];
  try {
    try {
      const raw = await requestControl(
        layout.controlEndpoint,
        {
          command: "revoke-devices",
          ...(scope.all ? { all: true } : { deviceId: scope.deviceId }),
        },
        MANAGEMENT_COMMAND_TIMEOUT_MS,
      );
      revoked = revokeDevicesResultSchema.parse(raw).revoked;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
      // server 已停止（Supervisor 不存在，Core 必然不在运行）时直接改 devices.json。
      const store = await createDeviceTokenStore(layout);
      if (scope.all) {
        revoked = await store.revokeAll();
      } else {
        const revokedId = await store.revoke(scope.deviceId ?? "");
        revoked = revokedId ? [revokedId] : [];
      }
    }
    if (!scope.all && revoked.length === 0) {
      throw new ControlRequestError(
        "device-not-found",
        `Device ${scope.deviceId} not found`,
        false,
      );
    }
    if (json) writeLine(io, { revoked });
    else if (revoked.length === 0) writeLine(io, "No active devices to revoke");
    else
      writeLine(
        io,
        [`Revoked ${revoked.length} device(s)`, ...revoked.map((id) => `  ${id}`)].join("\n"),
      );
    return 0;
  } catch (error) {
    return reportManagementError(io, json, error);
  }
}

export async function runServeTokensCommand(
  args: readonly string[],
  io: ServeCommandIO,
  json: boolean,
  layout: ServerLayout,
): Promise<number> {
  // --json 是 runServerCli 的全局输出开关，不属于 tokens 子命令参数。
  const tokensArgs = args.filter((entry) => entry !== "--json");
  try {
    if (tokensArgs[0] === "revoke") {
      return await runServeTokensRevokeCommand(tokensArgs.slice(1), io, json, layout);
    }
    if (tokensArgs.length > 0) throw new Error(`Unknown tokens subcommand: ${tokensArgs[0]}`);
    const devices = await loadDeviceEntries(layout);
    if (json) writeLine(io, devices);
    else writeLine(io, formatDeviceTable(devices));
    return 0;
  } catch (error) {
    return reportManagementError(io, json, error);
  }
}
