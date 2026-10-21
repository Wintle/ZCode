import { useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import type { LocalServerHostingFailure, LocalServerPairingCode } from "@zcode/shared";
import { LOCAL_SERVER_DEFAULT_LAN_PORT } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useLocalServerHosting } from "@/hooks/useLocalServerHosting.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot } from "@/settings/StatusDot.js";

/**
 * 设置 › 远程设备 ›「本机作为被控端」面板（spec：docs/remote/lan-direct-connection.md）。
 * 只投影 main 进程 LocalServerHostingManager 经 zcode CLI 返回的事实；
 * 打开面板刷新一次、手动刷新，不做高频轮询。仅桌面渲染（父级已用 isDesktop 门禁）。
 */

const PAIRING_COUNTDOWN_TICK_MS = 1_000;
const PAIRING_INSTALL_COMMAND = `zcode serve --daemon --host 0.0.0.0 --port ${LOCAL_SERVER_DEFAULT_LAN_PORT}`;

function formatRelativeTime(
  timestamp: number,
  locale: string,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return formatMessage({ id: "common.justNow" });
  if (elapsed < 60 * 60_000) {
    return formatMessage({ id: "common.minutesAgo" }, { count: Math.floor(elapsed / 60_000) });
  }
  if (elapsed < 24 * 60 * 60_000) {
    return formatMessage({ id: "common.hoursAgo" }, { count: Math.floor(elapsed / (60 * 60_000)) });
  }
  if (elapsed < 48 * 60 * 60_000) return formatMessage({ id: "common.yesterday" });
  return new Date(timestamp).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function LocalServerHostingPanel() {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hosting = useLocalServerHosting();
  const { status, devices, addresses, loading } = hosting;

  const [portInput, setPortInput] = useState(String(LOCAL_SERVER_DEFAULT_LAN_PORT));
  const [portError, setPortError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pairing, setPairing] = useState<LocalServerPairingCode | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingFailure, setPairingFailure] = useState<LocalServerHostingFailure | null>(null);
  const [revokingIds, setRevokingIds] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  // 配对码倒计时：只在有未过期配对码时走时钟。
  useEffect(() => {
    if (!pairing || pairing.expiresAt <= now) return;
    const timer = setInterval(() => setNow(Date.now()), PAIRING_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [pairing, now]);

  const pairingSecondsLeft = useMemo(() => {
    if (!pairing) return 0;
    return Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  }, [pairing, now]);

  // 本机地址按可读性排序展示；复制单条 IP:端口 用当前生效端口（停止态回退输入端口）。
  const listenPortForAddresses =
    status?.listenPort ?? (Number(portInput) || LOCAL_SERVER_DEFAULT_LAN_PORT);
  const activeDevices = devices.filter((device) => device.status === "active");

  if (!hosting.supported) return null;

  const parsePort = (): number | null => {
    const value = Number(portInput);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      setPortError(intl.formatMessage({ id: "settings.localServerHosting.portInvalid" }));
      return null;
    }
    setPortError(null);
    return value;
  };

  const handleToggle = async (checked: boolean): Promise<void> => {
    if (checked) {
      const port = parsePort();
      if (port === null) return;
      setToggling(true);
      try {
        const result = await hosting.setLanEnabled({ enabled: true, port });
        if (!result.ok) return;
        if (result.value.needsInstall) {
          const confirmed = await confirmDialog({
            title: intl.formatMessage({
              id: "settings.localServerHosting.installConfirmTitle",
            }),
            description: intl.formatMessage({
              id: "settings.localServerHosting.installConfirmDescription",
            }),
            confirmLabel: intl.formatMessage({
              id: "settings.localServerHosting.installConfirmAction",
            }),
          });
          if (!confirmed) return;
          setInstalling(true);
          try {
            const installResult = await hosting.installAndStart({ port });
            if (!installResult.ok) {
              toast(describeFailure(installResult.failure, intl.formatMessage), {
                variant: "warning",
              });
            }
          } finally {
            setInstalling(false);
          }
        }
      } finally {
        setToggling(false);
      }
      return;
    }
    setToggling(true);
    try {
      const result = await hosting.setLanEnabled({ enabled: false });
      if (!result.ok) {
        toast(describeFailure(result.failure, intl.formatMessage), { variant: "warning" });
      }
    } finally {
      setToggling(false);
    }
  };

  const handleGeneratePairingCode = async (): Promise<void> => {
    setPairingBusy(true);
    setPairingFailure(null);
    try {
      const result = await hosting.generatePairingCode();
      if (result.ok) {
        setPairing(result.value);
        setNow(Date.now());
      } else {
        setPairing(null);
        setPairingFailure(result.failure);
      }
    } finally {
      setPairingBusy(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string, name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.localServerHosting.devices.revokeConfirmTitle" }),
      description: intl.formatMessage(
        { id: "settings.localServerHosting.devices.revokeConfirmDescription" },
        { name },
      ),
      confirmLabel: intl.formatMessage({ id: "settings.localServerHosting.devices.revoke" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setRevokingIds((prev) => new Set(prev).add(deviceId));
    try {
      const result = await hosting.revokeDevice(deviceId);
      if (!result.ok) {
        toast(describeFailure(result.failure, intl.formatMessage), { variant: "warning" });
      }
    } finally {
      setRevokingIds((prev) => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
    }
  };

  const handleRevokeAll = async (): Promise<void> => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({
        id: "settings.localServerHosting.devices.revokeAllConfirmTitle",
      }),
      description: intl.formatMessage(
        { id: "settings.localServerHosting.devices.revokeAllConfirmDescription" },
        { count: activeDevices.length },
      ),
      confirmLabel: intl.formatMessage({ id: "settings.localServerHosting.devices.revokeAll" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    const result = await hosting.revokeAll();
    if (!result.ok) {
      toast(describeFailure(result.failure, intl.formatMessage), { variant: "warning" });
    }
  };

  const busy = toggling || installing;

  return (
    <section
      className="border-t border-border pt-4"
      aria-label={intl.formatMessage({ id: "settings.localServerHosting.title" })}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.localServerHosting.title" })}
          </h3>
          <p className="mt-1 text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.localServerHosting.description" })}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          aria-label={intl.formatMessage({ id: "settings.localServerHosting.refresh" })}
          onClick={() => void hosting.refresh()}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          {intl.formatMessage({ id: "settings.localServerHosting.refresh" })}
        </Button>
      </div>

      {status && status.failure ? (
        <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2">
          <p role="alert" className="text-ui-sm text-destructive">
            {describeFailure(status.failure, intl.formatMessage)}
          </p>
          {status.failure.code === "cli-unavailable" ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-ui-sm text-foreground-subtle">
                {PAIRING_INSTALL_COMMAND}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(PAIRING_INSTALL_COMMAND);
                  toast(
                    intl.formatMessage({ id: "settings.localServerHosting.copyCommandSuccess" }),
                  );
                }}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.localServerHosting.copyCommand" })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {status ? (
        <SettingsGroupCard>
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-sm">
              <span className="flex items-center gap-2 text-foreground">
                <StatusDot tone={status.running ? "green" : "muted"} />
                {status.running
                  ? intl.formatMessage({ id: "settings.localServerHosting.status.running" })
                  : intl.formatMessage({ id: "settings.localServerHosting.status.stopped" })}
              </span>
              <span className="text-remote-foreground-muted">
                {status.lanEnabled && status.listenHost
                  ? intl.formatMessage(
                      { id: "settings.localServerHosting.status.listenLan" },
                      {
                        address: `${status.listenHost}:${status.listenPort ?? "?"}`,
                      },
                    )
                  : intl.formatMessage({
                      id: "settings.localServerHosting.status.listenLocal",
                    })}
              </span>
              <span className="text-remote-foreground-muted">
                {status.pairedDeviceCount === null
                  ? intl.formatMessage({
                      id: "settings.localServerHosting.status.deviceCountUnknown",
                    })
                  : intl.formatMessage(
                      { id: "settings.localServerHosting.status.deviceCount" },
                      { count: status.pairedDeviceCount },
                    )}
              </span>
            </div>

            <SettingsRow
              label={intl.formatMessage({
                id: "settings.localServerHosting.lanToggle.label",
              })}
              description={intl.formatMessage({
                id: "settings.localServerHosting.lanToggle.description",
              })}
              control={
                <div className="flex items-center gap-2">
                  <Switch
                    checked={status.lanEnabled}
                    disabled={busy}
                    aria-busy={busy}
                    aria-label={intl.formatMessage({
                      id: "settings.localServerHosting.lanToggle.label",
                    })}
                    onCheckedChange={(checked) => void handleToggle(checked)}
                  />
                </div>
              }
            />

            {!status.lanEnabled ? (
              <div className="flex items-center gap-2">
                <label
                  className="text-ui-sm text-remote-foreground-muted"
                  htmlFor="local-server-lan-port"
                >
                  {intl.formatMessage({ id: "settings.localServerHosting.lanToggle.portLabel" })}
                </label>
                <Input
                  id="local-server-lan-port"
                  type="text"
                  inputMode="numeric"
                  className="w-24"
                  value={portInput}
                  aria-invalid={portError !== null}
                  onChange={(event) => {
                    setPortInput(event.target.value);
                    setPortError(null);
                  }}
                />
                {portError ? (
                  <span role="alert" className="text-ui-sm text-destructive">
                    {portError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsGroupCard>
      ) : null}

      {addresses.length > 0 ? (
        <div className="mt-3">
          <p className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.localServerHosting.addresses.title" })}
          </p>
          <ul className="mt-1 space-y-1">
            {addresses.map((entry) => {
              const display = `${entry.address}:${listenPortForAddresses}`;
              return (
                <li key={`${entry.family}:${entry.address}`} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-ui-sm text-foreground-subtle">
                    {display}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={intl.formatMessage(
                      { id: "settings.localServerHosting.addresses.copy" },
                      { address: display },
                    )}
                    onClick={() => {
                      void navigator.clipboard.writeText(display);
                      toast(
                        intl.formatMessage(
                          { id: "settings.localServerHosting.addresses.copySuccess" },
                          { address: display },
                        ),
                      );
                    }}
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pairingBusy || !status?.running}
            aria-busy={pairingBusy}
            onClick={() => void handleGeneratePairingCode()}
          >
            {pairingBusy
              ? intl.formatMessage({ id: "settings.localServerHosting.pairing.generating" })
              : intl.formatMessage({ id: "settings.localServerHosting.pairing.generate" })}
          </Button>
          <span className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.localServerHosting.pairing.hint" })}
          </span>
        </div>
        {pairingFailure ? (
          <p role="alert" className="mt-1 text-ui-sm text-destructive">
            {describeFailure(pairingFailure, intl.formatMessage)}
          </p>
        ) : null}
        {pairing ? (
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all rounded-md bg-surface px-2 py-1 font-mono text-ui-sm text-foreground">
              {pairing.code}
            </code>
            <span
              className={`text-ui-xs ${pairingSecondsLeft > 0 ? "text-remote-foreground-muted" : "text-destructive"}`}
            >
              {pairingSecondsLeft > 0
                ? intl.formatMessage(
                    { id: "settings.localServerHosting.pairing.expiresIn" },
                    { seconds: pairingSecondsLeft },
                  )
                : intl.formatMessage({ id: "settings.localServerHosting.pairing.expired" })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={intl.formatMessage({
                id: "settings.localServerHosting.pairing.copy",
              })}
              onClick={() => {
                void navigator.clipboard.writeText(pairing.code);
                toast(
                  intl.formatMessage({
                    id: "settings.localServerHosting.pairing.copySuccess",
                  }),
                );
              }}
            >
              <Copy className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-ui-sm text-foreground">
            {intl.formatMessage({ id: "settings.localServerHosting.devices.title" })}
            {activeDevices.length > 0 ? (
              <span className="ml-1 text-ui-xs text-remote-foreground-muted">
                {activeDevices.length}
              </span>
            ) : null}
          </p>
          {activeDevices.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => void handleRevokeAll()}
            >
              {intl.formatMessage({ id: "settings.localServerHosting.devices.revokeAll" })}
            </Button>
          ) : null}
        </div>
        {activeDevices.length === 0 ? (
          <p className="mt-1 text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.localServerHosting.devices.empty" })}
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
            {activeDevices.map((device) => {
              const revoking = revokingIds.has(device.id);
              return (
                <li key={device.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-ui-sm text-foreground">{device.name}</p>
                    <p className="text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage(
                        { id: "settings.localServerHosting.devices.lastSeen" },
                        {
                          time: formatRelativeTime(device.lastSeenAt, locale, intl.formatMessage),
                        },
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    disabled={revoking}
                    aria-busy={revoking}
                    onClick={() => void handleRevokeDevice(device.id, device.name)}
                  >
                    {intl.formatMessage({ id: "settings.localServerHosting.devices.revoke" })}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** 失败分类展示：优先稳定 code 文案，消息细节附在后（不静默、不伪造状态）。 */
function describeFailure(
  failure: LocalServerHostingFailure,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  switch (failure.code) {
    case "cli-unavailable":
      return formatMessage({ id: "settings.localServerHosting.error.cliUnavailable" });
    case "server-unavailable":
      return formatMessage({ id: "settings.localServerHosting.error.serverUnavailable" });
    case "timeout":
      return formatMessage({ id: "settings.localServerHosting.error.timeout" });
    case "invalid-request":
      return formatMessage({ id: "settings.localServerHosting.error.invalidRequest" });
    default:
      return failure.message;
  }
}
