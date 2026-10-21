// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  LocalServerHostingFailure,
  LocalServerHostingOperationResult,
  LocalServerHostingStatus,
  LocalServerLanToggleResult,
} from "@zcode/shared";

/**
 * 「本机作为被控端」面板 DOM 测试：mock 平台能力，验证状态投影渲染、
 * 开关端口校验、未装服务确认流、吊销确认与错误分类展示。
 */

const h = vi.hoisted(() => {
  const mocks = {
    getLocalServerHostingStatus: vi.fn(),
    generateLocalServerPairingCode: vi.fn(),
    listLocalServerDevices: vi.fn(),
    revokeLocalServerDevice: vi.fn(),
    revokeAllLocalServerDevices: vi.fn(),
    setLocalServerLanEnabled: vi.fn(),
    installAndStartLocalServer: vi.fn(),
    listLocalServerAddresses: vi.fn(),
    requestConfirmation: vi.fn(async () => true),
    clipboardWriteText: vi.fn(async () => {}),
  };
  // 平台对象必须跨渲染保持同一引用，否则 effect 依赖变化会导致重复刷新。
  const platformService = { ...mocks };
  return { ...mocks, platformService };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => h.platformService,
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => h.requestConfirmation,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { LocalServerHostingPanel } from "@/settings/LocalServerHostingPanel.js";

function baseStatus(overrides: Partial<LocalServerHostingStatus> = {}): LocalServerHostingStatus {
  return {
    cliAvailable: true,
    installed: true,
    running: true,
    state: "ready",
    listenHost: "127.0.0.1",
    listenPort: 8737,
    lanEnabled: false,
    pairedDeviceCount: 1,
    serviceRegistered: true,
    version: "3.12.0",
    failure: null,
    ...overrides,
  };
}

function okResult<T>(value: T): LocalServerHostingOperationResult<T> {
  return { ok: true, value };
}

function failResult<T>(failure: LocalServerHostingFailure): LocalServerHostingOperationResult<T> {
  return { ok: false, failure };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.getLocalServerHostingStatus.mockResolvedValue(baseStatus());
  h.listLocalServerDevices.mockResolvedValue(
    okResult([
      { id: "d1", name: "laptop", lastSeenAt: Date.now() - 60_000, status: "active" as const },
    ]),
  );
  h.listLocalServerAddresses.mockResolvedValue([
    { address: "192.168.1.5", family: "IPv4" as const },
  ]);
  h.requestConfirmation.mockResolvedValue(true);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: h.clipboardWriteText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

function renderPanel() {
  return render(createElement(LocalServerHostingPanel));
}

describe("LocalServerHostingPanel", () => {
  it("挂载时刷新一次并渲染状态：运行中、仅本机、设备数、本机地址", async () => {
    renderPanel();

    await waitFor(() => {
      expect(h.getLocalServerHostingStatus).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("settings.localServerHosting.status.running")).toBeTruthy();
    expect(screen.getByText("settings.localServerHosting.status.listenLocal")).toBeTruthy();
    expect(screen.getByText("settings.localServerHosting.status.deviceCount")).toBeTruthy();
    // 本机地址使用输入框默认端口 8737 拼接展示。
    expect(screen.getByText("192.168.1.5:8737")).toBeTruthy();
  });

  it("局域网监听时状态区展示 host:port", async () => {
    h.getLocalServerHostingStatus.mockResolvedValue(
      baseStatus({ lanEnabled: true, listenHost: "0.0.0.0", listenPort: 9000 }),
    );
    renderPanel();

    expect(await screen.findByText("settings.localServerHosting.status.listenLan")).toBeTruthy();
  });

  it("CLI 不可达时展示安装引导与可复制命令", async () => {
    const failure: LocalServerHostingFailure = {
      code: "cli-unavailable",
      message: "not found",
    };
    h.getLocalServerHostingStatus.mockResolvedValue(baseStatus({ cliAvailable: false, failure }));
    renderPanel();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("zcode serve --daemon --host 0.0.0.0 --port 8737")).toBeTruthy();
    expect(screen.getByText("settings.localServerHosting.copyCommand")).toBeTruthy();
  });

  it("开启局域网连接时携带端口调用 setLocalServerLanEnabled", async () => {
    const toggleResult: LocalServerLanToggleResult = {
      needsInstall: false,
      restartRequested: true,
      status: baseStatus({ lanEnabled: true }),
    };
    h.setLocalServerLanEnabled.mockResolvedValue(okResult(toggleResult));
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "settings.localServerHosting.lanToggle.label",
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(h.setLocalServerLanEnabled).toHaveBeenCalledWith({ enabled: true, port: 8737 });
    });
    // 开关后刷新一次状态。
    expect(h.getLocalServerHostingStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("端口非法时拒绝开启并展示校验错误", async () => {
    renderPanel();
    const portInput = (await screen.findByLabelText(
      "settings.localServerHosting.lanToggle.portLabel",
    )) as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: "99999" } });
    fireEvent.click(
      screen.getByRole("switch", { name: "settings.localServerHosting.lanToggle.label" }),
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(h.setLocalServerLanEnabled).not.toHaveBeenCalled();
  });

  it("未安装服务时：确认后走 installAndStart，取消则不安装", async () => {
    h.setLocalServerLanEnabled.mockResolvedValue(
      okResult({
        needsInstall: true,
        restartRequested: false,
        status: baseStatus({ installed: false }),
      } satisfies LocalServerLanToggleResult),
    );
    h.installAndStartLocalServer.mockResolvedValue(okResult(baseStatus()));
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "settings.localServerHosting.lanToggle.label",
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(h.requestConfirmation).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(h.installAndStartLocalServer).toHaveBeenCalledWith({ port: 8737 });
    });

    // 取消确认时不触发安装。
    h.installAndStartLocalServer.mockClear();
    h.requestConfirmation.mockResolvedValueOnce(false);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(h.requestConfirmation).toHaveBeenCalledTimes(2);
    });
    expect(h.installAndStartLocalServer).not.toHaveBeenCalled();
  });

  it("关闭局域网连接时调用 setLocalServerLanEnabled({enabled:false})", async () => {
    h.getLocalServerHostingStatus.mockResolvedValue(
      baseStatus({ lanEnabled: true, listenHost: "0.0.0.0" }),
    );
    h.setLocalServerLanEnabled.mockResolvedValue(
      okResult({
        needsInstall: false,
        restartRequested: true,
        status: baseStatus(),
      } satisfies LocalServerLanToggleResult),
    );
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "settings.localServerHosting.lanToggle.label",
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(h.setLocalServerLanEnabled).toHaveBeenCalledWith({ enabled: false });
    });
  });

  it("生成配对码后展示码与倒计时", async () => {
    h.generateLocalServerPairingCode.mockResolvedValue(
      okResult({
        code: "abc123",
        expiresAt: Date.now() + 600_000,
        host: "192.168.1.5",
        port: 8737,
      }),
    );
    renderPanel();
    const generateButton = await screen.findByRole("button", {
      name: "settings.localServerHosting.pairing.generate",
    });

    fireEvent.click(generateButton);

    expect(await screen.findByText("abc123")).toBeTruthy();
    expect(h.generateLocalServerPairingCode).toHaveBeenCalledTimes(1);
  });

  it("配对失败时展示分类原因而非码", async () => {
    h.generateLocalServerPairingCode.mockResolvedValue(
      failResult({ code: "server-unavailable", message: "not running" }),
    );
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.localServerHosting.pairing.generate" }),
    );

    expect(
      await screen.findByText("settings.localServerHosting.error.serverUnavailable"),
    ).toBeTruthy();
  });

  it("吊销单个设备需确认并携带设备 id", async () => {
    h.revokeLocalServerDevice.mockResolvedValue(okResult({ revoked: ["d1"] }));
    renderPanel();
    const revokeButton = (
      await screen.findAllByRole("button", {
        name: "settings.localServerHosting.devices.revoke",
      })
    )[0]!;

    fireEvent.click(revokeButton);

    await waitFor(() => {
      expect(h.requestConfirmation).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(h.revokeLocalServerDevice).toHaveBeenCalledWith("d1");
    });
  });

  it("全部吊销需确认", async () => {
    h.revokeAllLocalServerDevices.mockResolvedValue(okResult({ revoked: ["d1"] }));
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "settings.localServerHosting.devices.revokeAll",
      }),
    );

    await waitFor(() => {
      expect(h.revokeAllLocalServerDevices).toHaveBeenCalled();
    });
  });

  it("无设备时展示空态", async () => {
    h.listLocalServerDevices.mockResolvedValue(okResult([]));
    h.getLocalServerHostingStatus.mockResolvedValue(baseStatus({ pairedDeviceCount: 0 }));
    renderPanel();

    expect(await screen.findByText("settings.localServerHosting.devices.empty")).toBeTruthy();
  });
});
