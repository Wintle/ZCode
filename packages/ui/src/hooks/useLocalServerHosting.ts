import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalServerAddressEntry,
  LocalServerDeviceEntry,
  LocalServerHostingFailure,
  LocalServerHostingOperationResult,
  LocalServerHostingStatus,
  LocalServerInstallStartRequest,
  LocalServerLanEnabledRequest,
  LocalServerLanToggleResult,
  LocalServerPairingCode,
  LocalServerRevokeResult,
} from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

/**
 * 「本机作为被控端」hook：只投影 main 进程 LocalServerHostingManager 经 zcode CLI
 * 返回的事实。打开面板时刷新一次、支持手动刷新，不做高频轮询（spec 被控端界面配置）。
 */
export interface UseLocalServerHostingResult {
  /** 当前平台是否暴露被控端 bridge（Web 或旧 preload 为 false，UI 隐藏整块面板）。 */
  supported: boolean;
  status: LocalServerHostingStatus | null;
  devices: LocalServerDeviceEntry[];
  addresses: LocalServerAddressEntry[];
  loading: boolean;
  /** 手动刷新一次 status + devices；返回最新 status。 */
  refresh: () => Promise<LocalServerHostingStatus | null>;
  setLanEnabled: (
    request: LocalServerLanEnabledRequest,
  ) => Promise<LocalServerHostingOperationResult<LocalServerLanToggleResult>>;
  installAndStart: (
    request: LocalServerInstallStartRequest,
  ) => Promise<LocalServerHostingOperationResult<LocalServerHostingStatus>>;
  generatePairingCode: () => Promise<LocalServerHostingOperationResult<LocalServerPairingCode>>;
  revokeDevice: (
    deviceId: string,
  ) => Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>>;
  revokeAll: () => Promise<LocalServerHostingOperationResult<LocalServerRevokeResult>>;
}

export function useLocalServerHosting(): UseLocalServerHostingResult {
  const platform = useOptionalPlatform();
  const supported = Boolean(platform?.getLocalServerHostingStatus);
  const [status, setStatus] = useState<LocalServerHostingStatus | null>(null);
  const [devices, setDevices] = useState<LocalServerDeviceEntry[]>([]);
  const [addresses, setAddresses] = useState<LocalServerAddressEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<LocalServerHostingStatus | null> => {
    if (!platform?.getLocalServerHostingStatus) return null;
    setLoading(true);
    try {
      const nextStatus = await platform.getLocalServerHostingStatus();
      if (!mountedRef.current) return nextStatus;
      setStatus(nextStatus);
      // devices 查询失败不阻断状态展示；status.failure 已携带分类原因。
      if (platform.listLocalServerDevices) {
        const deviceResult = await platform.listLocalServerDevices();
        if (mountedRef.current && deviceResult.ok) setDevices(deviceResult.value);
      }
      return nextStatus;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    if (!supported || !platform?.getLocalServerHostingStatus) return;
    // 打开面板时刷新一次。
    void refresh();
    if (platform.listLocalServerAddresses) {
      void platform.listLocalServerAddresses().then((entries) => {
        if (mountedRef.current) setAddresses(entries);
      });
    }
  }, [platform, supported, refresh]);

  const setLanEnabled = useCallback(
    async (request: LocalServerLanEnabledRequest) => {
      if (!platform?.setLocalServerLanEnabled) {
        return unsupportedResult<LocalServerLanToggleResult>();
      }
      const result = await platform.setLocalServerLanEnabled(request);
      if (mountedRef.current) await refresh();
      return result;
    },
    [platform, refresh],
  );

  const installAndStart = useCallback(
    async (request: LocalServerInstallStartRequest) => {
      if (!platform?.installAndStartLocalServer) {
        return unsupportedResult<LocalServerHostingStatus>();
      }
      const result = await platform.installAndStartLocalServer(request);
      if (mountedRef.current) await refresh();
      return result;
    },
    [platform, refresh],
  );

  const generatePairingCode = useCallback(async () => {
    if (!platform?.generateLocalServerPairingCode) {
      return unsupportedResult<LocalServerPairingCode>();
    }
    return await platform.generateLocalServerPairingCode();
  }, [platform]);

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      if (!platform?.revokeLocalServerDevice) {
        return unsupportedResult<LocalServerRevokeResult>();
      }
      const result = await platform.revokeLocalServerDevice(deviceId);
      if (mountedRef.current) await refresh();
      return result;
    },
    [platform, refresh],
  );

  const revokeAll = useCallback(async () => {
    if (!platform?.revokeAllLocalServerDevices) {
      return unsupportedResult<LocalServerRevokeResult>();
    }
    const result = await platform.revokeAllLocalServerDevices();
    if (mountedRef.current) await refresh();
    return result;
  }, [platform, refresh]);

  return {
    supported,
    status,
    devices,
    addresses,
    loading,
    refresh,
    setLanEnabled,
    installAndStart,
    generatePairingCode,
    revokeDevice,
    revokeAll,
  };
}

function unsupportedResult<T>(): LocalServerHostingOperationResult<T> {
  const fail: LocalServerHostingFailure = {
    code: "cli-unavailable",
    message: "Local server hosting is unavailable on this platform",
  };
  return { ok: false, failure: fail };
}
