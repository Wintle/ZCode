export type RemoteConnectionAction =
  | "connect"
  | "disconnect"
  | "cancel"
  | "update-server"
  | "update-desktop"
  | "install"
  | "confirm-identity"
  | "credentials"
  | "edit-auth"
  | "edit-host"
  | "security"
  | "details"
  | "retry"
  /** 配对码错误：在配对阶段就地改码重试，不回退整张表单。 */
  | "pairing-retry"
  /** 设备被吊销或服务端要求鉴权：需要处理，修复操作是重新配对。 */
  | "re-pair"
  | "none";
