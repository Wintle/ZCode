import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

export interface ServerConnectOptions {
  kind: "server";
  /** 已运行的 zcode-server HTTP(S)/WS(S) 入口。 */
  url: string;
  /** 用户可读名称，仅用于展示。 */
  name?: string;
  /** 临时连接凭据；持久化时必须转成 credential key。 */
  token?: string;
  /** 首次/重新配对的一次性配对码；只允许存在于连接流程内存态，不落盘。 */
  pairingCode?: string;
  /** 服务端默认工作区路径，可被连接流程中的 workspacePath 覆盖。 */
  workspacePath?: string;
  /** 远端服务实例稳定标识，用于 workspaceIdentity authority。 */
  serverId?: string;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions
  | ServerConnectOptions;

/** 删除只应存在于当前连接流程中的 secret，供长期内存状态和跨进程回包使用。 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitized
    } = target;
    return sanitized;
  }

  if (target.kind === "server") {
    // 配对码与 token 同属只应存在于当前连接流程的 secret，持久化前一并剥除。
    const { token: _token, pairingCode: _pairingCode, ...sanitized } = target;
    return sanitized;
  }

  return target;
}
