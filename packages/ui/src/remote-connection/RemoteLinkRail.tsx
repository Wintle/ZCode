import type { RemoteTarget } from "@zcode/shared";

/** 直连目标统一展示 host:port；URL 只是存储形态，不直接回显给用户。 */
function formatServerRemoteAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "8737"}`;
  } catch {
    return url;
  }
}

export function formatRemoteLinkRailTarget(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return `WSL · ${target.distro ?? "default"}`;
    case "docker":
      return `Docker · ${target.container}`;
    case "server":
      return formatServerRemoteAddress(target.url);
  }
}

export function formatRemoteLinkRailDevice(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl":
      return target.distro ?? "WSL";
    case "docker":
      return target.container;
    case "server":
      return target.name?.trim() || formatServerRemoteAddress(target.url);
  }
}
