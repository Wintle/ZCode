import { ipcMain } from "electron";
import {
  PlatformChannels,
  localServerInstallStartRequestSchema,
  localServerLanEnabledRequestSchema,
  localServerRevokeDeviceRequestSchema,
  type LocalServerHostingFailure,
  type LocalServerHostingOperationResult,
} from "@zcode/shared";
import type { LocalServerHostingManager } from "./localServerHostingManager.js";

/**
 * 「本机作为被控端」IPC 装配（spec：docs/remote/lan-direct-connection.md）。
 * renderer 不直接 window.zcode；通道只把面板请求转发给 main 的唯一写入口
 * LocalServerHostingManager，入参一律经 shared zod schema 校验。
 */

function invalidRequestResult(message: string): LocalServerHostingOperationResult<never> {
  const fail: LocalServerHostingFailure = { code: "invalid-request", message };
  return { ok: false, failure: fail };
}

export function registerLocalServerHostingIpcHandlers(options: {
  localServerHostingManager: LocalServerHostingManager;
}): void {
  const manager = options.localServerHostingManager;

  ipcMain.handle(PlatformChannels.GetLocalServerHostingStatus, async () => {
    return await manager.getStatus();
  });

  ipcMain.handle(PlatformChannels.GenerateLocalServerPairingCode, async () => {
    return await manager.generatePairingCode();
  });

  ipcMain.handle(PlatformChannels.ListLocalServerDevices, async () => {
    return await manager.listDevices();
  });

  ipcMain.handle(PlatformChannels.RevokeLocalServerDevice, async (_event, payload: unknown) => {
    const parsed = localServerRevokeDeviceRequestSchema.safeParse(payload);
    if (!parsed.success) return invalidRequestResult("invalid revoke request");
    return await manager.revokeDevice(parsed.data.deviceId);
  });

  ipcMain.handle(PlatformChannels.RevokeAllLocalServerDevices, async () => {
    return await manager.revokeAll();
  });

  ipcMain.handle(PlatformChannels.SetLocalServerLanEnabled, async (_event, payload: unknown) => {
    const parsed = localServerLanEnabledRequestSchema.safeParse(payload);
    if (!parsed.success) return invalidRequestResult("invalid lan toggle request");
    return await manager.setLanEnabled(parsed.data);
  });

  ipcMain.handle(PlatformChannels.InstallAndStartLocalServer, async (_event, payload: unknown) => {
    const parsed = localServerInstallStartRequestSchema.safeParse(payload);
    if (!parsed.success) return invalidRequestResult("invalid install request");
    return await manager.installAndStart(parsed.data);
  });

  ipcMain.handle(PlatformChannels.ListLocalServerAddresses, async () => {
    return manager.listLocalAddresses();
  });
}
