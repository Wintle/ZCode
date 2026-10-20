import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ConnectionProfile,
  type RemoteTarget,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

export function remoteProjectHostIdForTarget(
  target: RemoteTarget,
  sourceServerId?: string,
): string {
  const identity = sourceServerId
    ? buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" })
    : buildRemoteWorkspaceIdentity("/", target);
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!hostId) throw new Error("remote-project.invalid-host-identity");
  return hostId;
}

export function remoteProjectHostIdForProfile(profile: ConnectionProfile): string {
  return remoteProjectHostIdForTarget(profile.target, profile.sourceServerId);
}

/** URL transport 沿用 CredentialService；成员服务只收到不含 secret 的连接快照。 */
export async function prepareRemoteServerConnection(input: {
  service: IRemoteProjectService;
  credentials: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
  };
  target: Extract<RemoteTarget, { kind: "server" }>;
  intent: "add" | "retain";
}) {
  const directory = await input.service.readDirectory();
  const requestedId = remoteProjectHostIdForTarget(input.target);
  const existing =
    directory.hosts.find((host) => host.id === requestedId) ??
    (!input.target.serverId
      ? directory.hosts.find(
          (host) => host.target?.kind === "server" && host.target.url === input.target.url,
        )
      : undefined);
  if (input.intent === "retain" && !existing) throw new Error("remote-project.host-removed");
  const saved = existing?.target?.kind === "server" ? existing.target : undefined;
  const id = existing?.id ?? requestedId;
  const tokenCredentialKey =
    saved?.tokenCredentialKey ?? (input.target.token ? `remote-server:${id}:token` : undefined);
  if (input.intent === "add" && input.target.token && tokenCredentialKey)
    await input.credentials.save(tokenCredentialKey, input.target.token);
  const target =
    input.intent === "retain" && saved
      ? saved
      : {
          ...stripRemoteTargetSecrets(input.target),
          ...(saved?.serverId ? { serverId: saved.serverId } : {}),
          ...(tokenCredentialKey ? { tokenCredentialKey } : {}),
        };
  const host = input.intent === "add" ? await input.service.saveHost({ id, target }) : existing!;
  if (host.target?.kind !== "server") throw new Error("remote-project.invalid-server");
  const { tokenCredentialKey: key, ...connectionTarget } = host.target;
  const token = key ? await input.credentials.load(key) : undefined;
  if (key && !token) throw new Error("remote-project.credential-unavailable");
  const pairingCode = input.target.pairingCode?.trim();
  return {
    // 连接目标是内存态：保留本次请求的配对码供握手消费；saveHost 已按脱敏快照落库。
    target: {
      ...connectionTarget,
      ...(token ? { token } : {}),
      ...(pairingCode ? { pairingCode } : {}),
    },
    /**
     * 配对换回的设备 Token 只有这一个写入点，与手工输入 token 共用同一
     * `remote-server:<hostId>:token` key 与快照 tokenCredentialKey 字段；
     * 一次性配对码消费后必须立刻固化键名，握手失败后的重连才能找回凭据。
     */
    async persistDeviceToken(deviceToken: string) {
      const pairingToken = deviceToken.trim();
      if (!pairingToken) throw new Error("remote-project.invalid-pairing-token");
      const current = (await input.service.readDirectory()).hosts.find(
        (item) => item.id === host.id,
      );
      if (!current || current.target?.kind !== "server")
        throw new Error("remote-project.host-removed");
      const credentialKey = key ?? `remote-server:${id}:token`;
      await input.credentials.save(credentialKey, pairingToken);
      if (!current.target.tokenCredentialKey) {
        await input.service.saveHost({
          id: current.id,
          target: { ...current.target, tokenCredentialKey: credentialKey },
        });
      }
    },
    async commit(sourceServerId: string, facts?: { name?: string }) {
      const bound = await input.service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId: remoteProjectHostIdForTarget(connectionTarget, sourceServerId),
      });
      if (!bound) throw new Error("remote-project.host-removed");
      // 设备名默认取 server-info（name，其次 hostname）；只补快照缺省，不覆盖用户命名。
      const defaultName = facts?.name?.trim();
      if (defaultName && bound.target?.kind === "server" && !bound.target.name) {
        await input.service.saveHost({
          id: bound.id,
          target: { ...bound.target, name: defaultName },
        });
      }
    },
  };
}

/** 注入既有连接管理器；成员关系不承担网络状态、重试或凭据解析。 */
export function createRemoteProjectConnectionAdmission(service: IRemoteProjectService) {
  return async (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }): Promise<(sourceServerId: string) => Promise<void>> => {
    const id = remoteProjectHostIdForProfile(input.profile);
    const host =
      input.intent === "add"
        ? await service.saveHost({ id, target: input.profile.target })
        : (await service.readDirectory()).hosts.find((item) => item.id === id);
    if (!host) throw new Error("remote-project.host-removed");
    return async (sourceServerId) => {
      const resolvedId = remoteProjectHostIdForProfile({ ...input.profile, sourceServerId });
      const bound = await service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId,
        createDistinctHost: input.confirmIdentityChange,
      });
      if (!bound) throw new Error("remote-project.host-removed");
    };
  };
}
