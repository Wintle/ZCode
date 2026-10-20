import { describe, expect, it } from "vitest";
import {
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "../src/remote-workspace-identity.js";
import { stripRemoteTargetSecrets } from "../src/remoteTarget.js";
import { hostIncomingMessageSchema, remoteTargetSchema } from "../src/validation.js";

describe("server remote target", () => {
  it("accepts server remote target payloads", () => {
    const parsed = remoteTargetSchema.safeParse({
      kind: "server",
      url: "https://intranet.example.invalid:3030",
      name: "Studio",
      token: "secret",
      workspacePath: "/Users/dev/ZCodeProject",
      serverId: "studio",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        kind: "server",
        url: "https://intranet.example.invalid:3030",
      });
    }
  });

  it("accepts server target in window Host connect messages", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "connect-remote-workspace",
      requestId: "connect-server-1",
      target: {
        kind: "server",
        url: "https://intranet.example.invalid:3030",
        workspacePath: "/Users/dev/ZCodeProject",
        serverId: "studio",
      },
      remoteAssets: {},
      workspacePath: "/Users/dev/ZCodeProject",
      workspaceIdentity: "remote:server:studio:/Users/dev/ZCodeProject",
    });

    expect(parsed.success).toBe(true);
  });

  it("builds and parses server workspace identities", () => {
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "Studio Server 01",
      workspacePath: "\\Users\\dev\\ZCodeProject\\",
    });

    expect(identity).toBe("remote:server:studio-server-01:/Users/dev/ZCodeProject");
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "server",
      sourceServerId: "studio-server-01",
      workspacePath: "/Users/dev/ZCodeProject",
    });
  });

  it("接受连接流程内存态的配对码，且与 token 一同被脱敏剥除", () => {
    const parsed = remoteTargetSchema.safeParse({
      kind: "server",
      url: "http://192.168.1.5:8737",
      pairingCode: "AbCd-1234",
    });
    expect(parsed.success).toBe(true);
    // 配对码与 token 一样只活在连接流程里；任何持久化/跨进程回包都必须先剥除。
    expect(
      stripRemoteTargetSecrets({
        kind: "server",
        url: "http://192.168.1.5:8737",
        pairingCode: "AbCd-1234",
        token: "device-token",
      }),
    ).toEqual({ kind: "server", url: "http://192.168.1.5:8737" });
  });

  it("rejects malformed server targets and identities", () => {
    expect(remoteTargetSchema.safeParse({ kind: "server", url: "not a url" }).success).toBe(false);
    expect(parseRemoteWorkspaceIdentity("remote:server::/workspace")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("remote:server:studio:relative")).toBeNull();
  });
});
