import { Box, Network, Server, TerminalSquare } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveRemoteConnectionPresentation,
  type RemoteConnectionPresentation,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";
export { formatConnectionProfileTarget } from "@/lib/remoteConnectionPresentation.js";

export type RemoteConnectionDisplayStatus = RemoteConnectionStatus;

/** UI 层的连接类型全集；持久化枚举（SourceServerTransportKind）不因直连扩展。 */
export type RemoteConnectionKind = RemoteTarget["kind"];

/**
 * 连接类型的唯一配色来源。类型 token 只表达连接类型（DESIGN.md），
 * 类型标签、新建连接表单的类型切换、关联标签与候选图标块共用（RDUX-27）。
 */
export const REMOTE_KIND_PRESENTATION = {
  ssh: {
    Icon: Server,
    className: "border-remote-ssh-border bg-remote-ssh-surface text-remote-ssh-foreground",
    selectedClassName:
      "bg-remote-ssh-surface text-remote-ssh-foreground ring-1 ring-inset ring-remote-ssh-border",
    tileClassName: "bg-remote-ssh-surface text-remote-ssh-foreground",
  },
  wsl: {
    Icon: TerminalSquare,
    className: "border-remote-wsl-border bg-remote-wsl-surface text-remote-wsl-foreground",
    selectedClassName:
      "bg-remote-wsl-surface text-remote-wsl-foreground ring-1 ring-inset ring-remote-wsl-border",
    tileClassName: "bg-remote-wsl-surface text-remote-wsl-foreground",
  },
  docker: {
    Icon: Box,
    className: "border-remote-docker-border bg-remote-docker-surface text-remote-docker-foreground",
    selectedClassName:
      "bg-remote-docker-surface text-remote-docker-foreground ring-1 ring-inset ring-remote-docker-border",
    tileClassName: "bg-remote-docker-surface text-remote-docker-foreground",
  },
  // 直连图标用 Network：CloudIcon 与五态状态云语义冲突（直连规格）。
  server: {
    Icon: Network,
    className: "border-remote-server-border bg-remote-server-surface text-remote-server-foreground",
    selectedClassName:
      "bg-remote-server-surface text-remote-server-foreground ring-1 ring-inset ring-remote-server-border",
    tileClassName: "bg-remote-server-surface text-remote-server-foreground",
  },
} as const satisfies Record<RemoteConnectionKind, object>;

/** 候选列表行左侧的类型图标块。 */
export function RemoteConnectionKindTile({ kind }: { kind: RemoteConnectionKind }) {
  const { Icon, tileClassName } = REMOTE_KIND_PRESENTATION[kind];
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", tileClassName)}
    >
      <Icon className="size-4" />
    </span>
  );
}

const BASE_TAG_CLASS_NAME =
  "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-ui-xs font-semibold";

export function RemoteConnectionKindTag({
  kind,
  className,
}: {
  kind: RemoteConnectionKind;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const presentation = REMOTE_KIND_PRESENTATION[kind];
  const Icon = presentation.Icon;
  return (
    <span
      data-remote-connection-kind={kind}
      className={cn(BASE_TAG_CLASS_NAME, presentation.className, className)}
    >
      <Icon className="size-3" />
      {intl.formatMessage({ id: `remote.kind.${kind}` })}
    </span>
  );
}

export function RemoteConnectionStatusTag({
  status,
  presentation: supplied,
  className,
}: {
  status?: RemoteConnectionDisplayStatus;
  presentation?: RemoteConnectionPresentation;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const presentation = supplied ?? resolveRemoteConnectionPresentation({ state: status });
  return (
    <span
      role="status"
      aria-atomic="true"
      data-remote-connection-status={presentation.status}
      className={cn(
        BASE_TAG_CLASS_NAME,
        presentation.foreground,
        presentation.surface,
        presentation.border,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", presentation.dot)} />
      {intl.formatMessage({ id: presentation.messageId })}
      {presentation.recovery ? (
        <>
          {" · "}
          <span>
            {intl.formatMessage(
              { id: presentation.recovery.shortMessageId },
              presentation.recovery.values,
            )}
          </span>
        </>
      ) : presentation.shortMessageId !== presentation.messageId ? (
        <>
          {" "}
          · <span>{intl.formatMessage({ id: presentation.shortMessageId })}</span>
        </>
      ) : null}
    </span>
  );
}
