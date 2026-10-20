import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runServerCli } from "../src/cli.js";
import { ControlRequestError } from "../src/ipc/controlError.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { createDaemonServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import type { ServerLayout } from "../src/runtime/paths.js";

async function createFixture(): Promise<{ root: string; layout: ServerLayout }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-lan-cli-"));
  const layout = resolveServerLayout(join(root, "server"));
  return { root, layout };
}

async function runCli(
  argv: readonly string[],
): Promise<{ exit: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runServerCli(argv, {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });
  return { exit, stdout, stderr };
}

function serveArgs(layout: ServerLayout, ...extra: readonly string[]): string[] {
  return ["serve", ...extra, "--server-root", layout.serverRoot];
}

async function writeDevicesFile(layout: ServerLayout): Promise<{ activeId: string }> {
  const activeId = "11111111-2222-3333-4444-555555555555";
  const revokedId = "99999999-8888-7777-6666-555555555555";
  await mkdir(layout.serverRoot, { recursive: true });
  await writeFile(
    layout.devicesFile,
    `${JSON.stringify(
      {
        serverId: "server-installation-id",
        devices: [
          {
            id: activeId,
            name: "laptop",
            tokenHash: "a".repeat(64),
            createdAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_100_000,
            revokedAt: null,
          },
          {
            id: revokedId,
            name: "phone",
            tokenHash: "b".repeat(64),
            createdAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_100_000,
            revokedAt: 1_700_000_200_000,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { activeId };
}

describe("serve pairing and token management CLI", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("routes `serve pair` through the supervisor control channel and renders a copyable block", async () => {
    const { layout } = await createFixture();
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "pair") throw new Error(`Unexpected command ${request.command}`);
      return {
        code: "0123456789abcdef",
        expiresAt: Date.now() + 600_000,
        host: "192.168.1.5",
        port: 8737,
      };
    });
    cleanups.push(() => control.close());

    const json = await runCli([...serveArgs(layout, "pair"), "--json"]);
    expect(json.exit).toBe(0);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      code: "0123456789abcdef",
      host: "192.168.1.5",
      port: 8737,
    });

    const text = await runCli(serveArgs(layout, "pair"));
    expect(text.exit).toBe(0);
    const output = text.stdout.join("");
    expect(output).toContain("Address: 192.168.1.5");
    expect(output).toContain("Port: 8737");
    expect(output).toContain("Pairing code: 0123456789abcdef");
    expect(output).toContain("Valid until:");
  });

  it("reports pairing backoff failures with their stable code in --json", async () => {
    const { layout } = await createFixture();
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "pair") throw new Error(`Unexpected command ${request.command}`);
      throw new ControlRequestError("pairing-rate-limited", "Pairing is temporarily frozen", false);
    });
    cleanups.push(() => control.close());

    const result = await runCli([...serveArgs(layout, "pair"), "--json"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout.join(""))).toEqual({
      ok: false,
      code: "pairing-rate-limited",
      error: "Pairing is temporarily frozen",
    });
  });

  it("fails `serve pair` with a friendly message when the server is not running", async () => {
    const { layout } = await createFixture();
    const json = await runCli([...serveArgs(layout, "pair"), "--json"]);
    expect(json.exit).toBe(1);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      ok: false,
      error: expect.stringContaining("not running"),
    });

    const text = await runCli(serveArgs(layout, "pair"));
    expect(text.exit).toBe(1);
    expect(text.stderr.join("")).toContain("not running");
  });

  it("lists, revokes and scopes `serve tokens` through the supervisor control channel", async () => {
    const { layout } = await createFixture();
    const commands: string[] = [];
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      switch (request.command) {
        case "list-devices":
          return {
            devices: [
              {
                id: "d1",
                name: "laptop",
                lastSeenAt: 1_700_000_100_000,
                revokedAt: null,
                status: "active",
              },
              {
                id: "d2",
                name: "phone",
                lastSeenAt: 1_700_000_200_000,
                revokedAt: 1_700_000_300_000,
                status: "revoked",
              },
            ],
          };
        case "revoke-devices":
          return { revoked: "deviceId" in request ? [request.deviceId] : ["d1", "d2"] };
        default:
          throw new Error(`Unexpected command ${request.command}`);
      }
    });
    cleanups.push(() => control.close());

    const listJson = await runCli([...serveArgs(layout, "tokens"), "--json"]);
    expect(listJson.exit).toBe(0);
    expect(JSON.parse(listJson.stdout.join(""))).toHaveLength(2);

    const listText = await runCli(serveArgs(layout, "tokens"));
    expect(listText.exit).toBe(0);
    const table = listText.stdout.join("");
    expect(table).toContain("ID\tNAME\tLAST SEEN\tSTATUS");
    expect(table).toContain("d1\tlaptop");
    expect(table).toContain("active");
    expect(table).toContain("revoked");

    const revokeOne = await runCli([...serveArgs(layout, "tokens", "revoke", "d1"), "--json"]);
    expect(revokeOne.exit).toBe(0);
    expect(JSON.parse(revokeOne.stdout.join(""))).toEqual({ revoked: ["d1"] });

    const revokeAll = await runCli([...serveArgs(layout, "tokens", "revoke", "--all"), "--json"]);
    expect(revokeAll.exit).toBe(0);
    expect(JSON.parse(revokeAll.stdout.join(""))).toEqual({ revoked: ["d1", "d2"] });
    expect(commands).toEqual(["list-devices", "list-devices", "revoke-devices", "revoke-devices"]);

    const unknown = await runCli([...serveArgs(layout, "tokens", "subcommand")]);
    expect(unknown.exit).toBe(1);
    expect(unknown.stderr.join("")).toContain("Unknown tokens subcommand");
  });

  it("reads and revokes devices.json directly when the server is stopped", async () => {
    const { layout } = await createFixture();
    const { activeId } = await writeDevicesFile(layout);

    const list = await runCli([...serveArgs(layout, "tokens"), "--json"]);
    expect(list.exit).toBe(0);
    const entries = JSON.parse(list.stdout.join("")) as Array<{
      id: string;
      status: string;
      tokenHash?: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.id === activeId)?.status).toBe("active");
    // 输出不回显 token 或哈希。
    expect(entries.every((entry) => entry.tokenHash === undefined)).toBe(true);
    expect(list.stdout.join("")).not.toContain("a".repeat(64));

    const revoke = await runCli([...serveArgs(layout, "tokens", "revoke", activeId), "--json"]);
    expect(revoke.exit).toBe(0);
    expect(JSON.parse(revoke.stdout.join(""))).toEqual({ revoked: [activeId] });
    const file = JSON.parse(await readFile(layout.devicesFile, "utf8")) as {
      devices: Array<{ id: string; revokedAt: number | null }>;
    };
    expect(file.devices.find((device) => device.id === activeId)?.revokedAt).toBeTypeOf("number");

    const missing = await runCli([
      ...serveArgs(layout, "tokens", "revoke", "no-such-device"),
      "--json",
    ]);
    expect(missing.exit).toBe(1);
    expect(JSON.parse(missing.stdout.join(""))).toEqual({
      ok: false,
      code: "device-not-found",
      error: "Device no-such-device not found",
    });

    const revokeAll = await runCli([...serveArgs(layout, "tokens", "revoke", "--all"), "--json"]);
    expect(revokeAll.exit).toBe(0);
    expect(JSON.parse(revokeAll.stdout.join(""))).toEqual({ revoked: [] });
  });

  it("fails fast on a non-loopback listen host without an explicit port (CLI or config)", async () => {
    const { layout } = await createFixture();
    const fromCli = await runCli(serveArgs(layout, "--host", "0.0.0.0"));
    expect(fromCli.exit).toBe(1);
    expect(fromCli.stderr.join("")).toContain("requires an explicit --port");

    await mkdir(layout.serverRoot, { recursive: true });
    await writeFile(layout.serverConfigFile, '{"listen":{"host":"0.0.0.0"}}', "utf8");
    const fromConfig = await runCli(serveArgs(layout));
    expect(fromConfig.exit).toBe(1);
    expect(fromConfig.stderr.join("")).toContain("requires an explicit --port");
  });

  it("rejects malformed serve listen flags before touching server state", async () => {
    const { layout } = await createFixture();
    const missingValue = await runCli(serveArgs(layout, "--host"));
    expect(missingValue.exit).toBe(1);
    expect(missingValue.stderr.join("")).toContain("--host requires a value");

    const badPort = await runCli(serveArgs(layout, "--port", "abc"));
    expect(badPort.exit).toBe(1);
    expect(badPort.stderr.join("")).toContain("--port must be an integer");

    const duplicate = await runCli(serveArgs(layout, "--host", "127.0.0.1", "--host", "::1"));
    expect(duplicate.exit).toBe(1);
    expect(duplicate.stderr.join("")).toContain("--host may only be specified once");

    // 失败发生在任何生命周期 IO 之前：server root 不被创建。
    await expect(readFile(layout.statusFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("injects effective listen arguments into the service descriptor only when configured", () => {
    const layout = resolveServerLayout("/tmp/zcode-lan-descriptor/server");
    const plain = createDaemonServiceDescriptor({ platform: "win32", layout });
    expect(JSON.parse(plain.content).args).toEqual([
      "serve",
      "--supervisor",
      "--service-entry",
      "--server-root",
      layout.serverRoot,
    ]);

    const configured = createDaemonServiceDescriptor({
      platform: "win32",
      layout,
      listenArgs: ["--host", "0.0.0.0", "--port", "8737"],
    });
    expect(JSON.parse(configured.content).args).toEqual([
      "serve",
      "--supervisor",
      "--service-entry",
      "--server-root",
      layout.serverRoot,
      "--host",
      "0.0.0.0",
      "--port",
      "8737",
    ]);
  });
});
