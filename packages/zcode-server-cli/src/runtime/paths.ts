import { readFile, realpath, rename, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { isLoopbackHost, serverListenConfigSchema, type ServerListenConfig } from "../contracts.js";

export interface ServerLayout {
  readonly dataBaseDir: string;
  readonly serverRoot: string;
  readonly releasesDir: string;
  readonly runDir: string;
  readonly currentFile: string;
  readonly pendingFile: string;
  readonly installFile: string;
  readonly componentsCacheDir: string;
  readonly stableBinDir: string;
  readonly statusFile: string;
  readonly ingressTokenFile: string;
  readonly serverConfigFile: string;
  readonly devicesFile: string;
  readonly lockFile: string;
  readonly controlEndpoint: string;
  readonly serviceDir: string;
  readonly uninstalledFile: string;
  readonly updateTransactionFile: string;
  readonly updateLockFile: string;
}

export function getDefaultServerDataRoot(): string {
  const configured = process.env.ZCODE_DATA_BASE_DIR?.trim();
  return join(configured || homedir(), ".zcode", "server");
}

export function resolveServerLayout(serverRoot = getDefaultServerDataRoot()): ServerLayout {
  const root = resolve(serverRoot);
  const runDir = join(root, "run");
  return {
    dataBaseDir: inferDataBaseDir(root),
    serverRoot: root,
    releasesDir: join(root, "releases"),
    runDir,
    currentFile: join(root, "current.json"),
    pendingFile: join(root, "pending.json"),
    installFile: join(root, "install.json"),
    componentsCacheDir: join(root, "cache", "components"),
    stableBinDir: join(root, "bin"),
    statusFile: join(runDir, "status.json"),
    ingressTokenFile: join(runDir, "ingress-token"),
    serverConfigFile: join(root, "server-config.json"),
    devicesFile: join(root, "devices.json"),
    lockFile: join(runDir, "server.lock"),
    controlEndpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-server-${stablePathId(root)}`
        : join(runDir, "control.sock"),
    serviceDir: join(root, "service"),
    uninstalledFile: join(root, "uninstalled.json"),
    updateTransactionFile: join(root, "update-transaction.json"),
    updateLockFile: join(runDir, "update.lock"),
  };
}

export async function resolveCanonicalServerRoot(
  serverRoot = getDefaultServerDataRoot(),
): Promise<string> {
  // 安装前 server root 可能尚不存在；向上找到最近的存在祖先做 realpath，再拼回缺失段，
  // 这样既能收敛已有符号链接，也不会因为 ENOENT 让首次安装失效。
  let candidate = assertServerDataRoot(serverRoot);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function resolveCanonicalServerLayout(
  serverRoot = getDefaultServerDataRoot(),
): Promise<ServerLayout> {
  return resolveServerLayout(await resolveCanonicalServerRoot(serverRoot));
}

function inferDataBaseDir(serverRoot: string): string {
  const parent = dirname(serverRoot);
  if (basename(serverRoot) === "server" && basename(parent) === ".zcode") {
    return dirname(parent);
  }
  // 非标准的显式 server root 仍保持隔离，不向其父目录扩散 Agent/SQLite 数据。
  return serverRoot;
}

export function stablePathId(pathValue: string): string {
  // Path is only used as a local endpoint name.  A short deterministic id avoids leaking
  // the full home path into a named pipe or service descriptor.
  let hash = 2166136261;
  for (const char of resolve(pathValue)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = normalize(resolve(rootPath));
  const candidate = normalize(resolve(candidatePath));
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.split(sep).includes(".."));
}

export interface UninstallTargetValidation {
  ok: boolean;
  reason?: "outside-server-root" | "home-directory" | "non-absolute";
  canonicalPath?: string;
}

export function validateUninstallTarget(
  serverRoot: string,
  target: string,
): UninstallTargetValidation {
  if (!isAbsolute(target)) {
    return { ok: false, reason: "non-absolute" };
  }
  const root = resolve(serverRoot);
  const canonicalPath = resolve(target);
  if (canonicalPath === resolve(homedir()) || canonicalPath === dirname(resolve(homedir()))) {
    return { ok: false, reason: "home-directory" };
  }
  if (!isPathWithin(root, canonicalPath)) {
    return { ok: false, reason: "outside-server-root", canonicalPath };
  }
  return { ok: true, canonicalPath };
}

export async function canonicalExistingPath(pathValue: string): Promise<string> {
  return await realpath(pathValue);
}

export function assertServerDataRoot(serverRoot: string): string {
  const resolved = resolve(serverRoot);
  if (!isAbsolute(resolved) || resolved === dirname(resolved)) {
    throw new Error("Invalid server data root");
  }
  return resolved;
}

export function serverDataRootFromBase(baseDir: string): string {
  return join(resolve(baseDir), ".zcode", "server");
}

// ---- <serverRoot>/server-config.json 监听配置 ----

/** 读取监听配置；文件缺失表示"未配置"，JSON/schema 损坏必须 fail-fast 而不是静默降级。 */
export async function readServerConfig(layout: ServerLayout): Promise<ServerListenConfig | null> {
  let raw: string;
  try {
    raw = await readFile(layout.serverConfigFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return serverListenConfigSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    throw new Error(
      `Invalid server config at ${layout.serverConfigFile}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** 原子写入监听配置（临时文件 + rename），与 status/ingress token 落盘语义一致。 */
export async function writeServerConfig(
  layout: ServerLayout,
  config: ServerListenConfig,
): Promise<void> {
  const parsed = serverListenConfigSchema.parse(config);
  await mkdir(layout.serverRoot, { recursive: true, mode: 0o700 });
  const temporary = `${layout.serverConfigFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, layout.serverConfigFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface ResolvedListenTarget {
  host: string;
  port?: number;
}

/**
 * 生效监听链路：CLI > 配置文件 > 默认。
 * 非回环 host 必须有 1～65535 的显式端口；缺失或 0（动态端口）都会让控制端无法定位，
 * 一律 fail-fast 而不是静默换端口。
 */
export function resolveListenTarget(
  cli: { host?: string | undefined; port?: number | undefined },
  config: ServerListenConfig | null | undefined,
): ResolvedListenTarget {
  const host = cli.host?.trim() || config?.listen?.host?.trim() || "127.0.0.1";
  const port = cli.port ?? config?.listen?.port;
  if (!isLoopbackHost(host) && !(typeof port === "number" && port >= 1)) {
    throw new Error(
      `Non-loopback listen host ${host} requires an explicit --port 1-65535 (refusing to start on a dynamic port)`,
    );
  }
  return { host, ...(port !== undefined ? { port } : {}) };
}
