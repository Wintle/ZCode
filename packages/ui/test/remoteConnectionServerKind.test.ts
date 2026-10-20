// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.js";
import {
  REMOTE_KIND_PRESENTATION,
  RemoteConnectionKindTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import {
  RemoteConnectionConnectingStep,
  resolveRemoteConnectionPhases,
} from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import {
  formatRemoteConnectionDescription,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zh[id] ?? id,
        ),
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("直连类型标签", () => {
  it("四种连接类型都有类型条目，直连使用 remote-server 类型色", () => {
    for (const kind of ["ssh", "wsl", "docker", "server"] as const) {
      expect(REMOTE_KIND_PRESENTATION[kind]).toBeTruthy();
    }
    expect(REMOTE_KIND_PRESENTATION.server.className).toContain("bg-remote-server-surface");
    expect(REMOTE_KIND_PRESENTATION.server.selectedClassName).toContain(
      "ring-remote-server-border",
    );
  });

  it("直连标签显示「直连」并携带类型标记", () => {
    render(createElement(RemoteConnectionKindTag, { kind: "server" }));
    const tag = document.querySelector('[data-remote-connection-kind="server"]');
    expect(tag?.textContent).toBe("直连");
  });
});

describe("选择屏直连入口", () => {
  function renderSelection() {
    render(
      createElement(RemoteConnectionSelection, {
        snapshot: null,
        onSelectProfile: vi.fn(),
        onNewConnection: vi.fn(),
        aliases: [],
        distros: [],
        containers: [],
        availableKinds: ["ssh", "server", "docker"],
        dockerAvailable: null,
        loading: false,
        discoveryError: "",
        onSelectAlias: vi.fn(),
        onSelectTarget: vi.fn(),
        remoteConversationWorkspaceBySourceServerId: {},
      }),
    );
  }

  it("底部提供直连局域网电脑按钮，且没有开发提示", () => {
    renderSelection();
    const button = screen.getByRole("button", { name: zh["remote.selection.new.server"] });
    expect(zh["remote.selection.new.server"]).toBe("直连局域网电脑");
    fireEvent.click(button);
    expect(screen.queryByText(/仅在开发模式/)).toBeNull();
  });
});

describe("直连四阶段", () => {
  it("server 阶段为建立直连通道 → 验证配对码 → 识别设备 → 启动连接", () => {
    const phases = resolveRemoteConnectionPhases([], { kind: "server" });
    expect(phases.map((phase) => phase.titleId)).toEqual([
      "remote.phase.channel.server",
      "remote.phase.verify",
      "remote.phase.identify",
      "remote.phase.handshake.server",
    ]);
  });

  it("非 server 保持原有四阶段不受影响", () => {
    const phases = resolveRemoteConnectionPhases([], { kind: "ssh" });
    expect(phases.map((phase) => phase.key)).toEqual([
      "channel",
      "identify",
      "deploy",
      "handshake",
    ]);
  });

  it("连接就绪后直连四阶段全部完成", () => {
    const phases = resolveRemoteConnectionPhases([], { kind: "server", connectionReady: true });
    expect(phases.every((phase) => phase.status === "complete")).toBe(true);
  });
});

describe("配对码错误的就地重试", () => {
  function renderPairingRetry(errorCode: string) {
    const onSubmit = vi.fn();
    render(
      createElement(PlatformProvider, {
        platform: {} as never,
        children: createElement(RemoteConnectionConnectingStep, {
          kind: "server",
          target: { kind: "server", url: "http://192.168.1.5:8737" },
          loading: false,
          logs: [],
          errorMessage: zh["remote.error.pairingCodeInvalid"],
          errorCode,
          onBack: vi.fn(),
          onRetry: vi.fn(),
          pairingRetry: { value: "NEW-CODE", onChange: vi.fn(), onSubmit },
        }),
      }),
    );
    return onSubmit;
  }

  it("配对码无效时在配对阶段显示改码输入并可重提交", () => {
    const onSubmit = renderPairingRetry("remote-pairing-code-invalid");
    const input = screen.getByTestId("server-pairing-retry-input") as HTMLInputElement;
    expect(input.value).toBe("NEW-CODE");
    expect(screen.getAllByText(zh["remote.error.pairingCodeInvalid"]).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: zh["remote.action.pairing-retry"] }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each(["remote-device-revoked", "remote-auth-required"] as const)(
    "%s 显示需要处理 · 重新配对并提供重新配对提交",
    (errorCode) => {
      const onSubmit = renderPairingRetry(errorCode);
      const presentation = resolveRemoteConnectionPresentation({ state: "failed", errorCode });
      expect(presentation.shortMessageId).toBe("remote.status.needsPairing");
      fireEvent.click(screen.getByRole("button", { name: zh["remote.action.re-pair"] }));
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it("连接页标题旁显示直连类型标签，不再有裸 Server 文本", () => {
    render(
      createElement(PlatformProvider, {
        platform: {} as never,
        children: createElement(RemoteConnectionConnectingStep, {
          kind: "server",
          loading: false,
          logs: [],
          errorMessage: "",
          onBack: vi.fn(),
          onRetry: vi.fn(),
        }),
      }),
    );
    expect(document.querySelector('[data-remote-connection-kind="server"]')).toBeTruthy();
  });
});

describe("直连描述投影", () => {
  it("连接描述为 类型名 · host:port，不回显 URL scheme", () => {
    const target = { kind: "server" as const, url: "http://192.168.1.5:8737" };
    expect(formatRemoteConnectionDescription(target)).toBe("Direct · 192.168.1.5:8737");
    expect(
      formatRemoteConnectionDescription(target, (kind) =>
        kind === "server" ? "直连" : (zh[`remote.kind.${kind}`] ?? kind),
      ),
    ).toBe("直连 · 192.168.1.5:8737");
  });
});
