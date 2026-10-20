# 局域网直连电脑（LAN Direct Connection）规格

状态：current（2026-10-20）。覆盖被控端 `zcode serve` 的非回环监听、配对码与设备 Token，以及控制端把直连升级为第四种一等连接类型的产品化。
事实基础：[Server workspace 连接](server-remote-workspace-connection.md)（现状 dev-only 直连链路）、[R3 主规格](../architecture/r3-source-server-remote-architecture.md)、[统一计划 §7](../architecture/unified-zcode-lite-server-multi-server-plan.md)。
连接类型体系与五态展示沿用 [连接 UX 规格](../architecture/remote-device-connection-ux-spec.md)（RDUX-10/11/27/03），本文只扩展种类，不另立展示规则。

## 产品语义

- 用户在被控电脑运行 `zcode serve`（可注册为系统服务常驻），在控制端按「地址 + 端口 + 配对码」把它添加为一台远程设备；之后它与 SSH / WSL / Docker 设备一样出现在选择屏、设置页设备卡与侧栏项目行。
- 连接类型标签为「直连」（英文 Direct），连接描述形如 `直连 · 192.168.1.5:8737`。局域网是主要场景但不是限制：端口可达的跨网直连同样成立；跨网不可达场景仍走手机远控 relay 链路，两者并存、互不替代。
- 控制端连接的是被控端上的 ZCode Server（`zcode serve`），不是被控端正在运行的桌面 App 会话；桌面会话的远程控制仍归 relay 链路，本规格不新增手机/网页直连（`allowRemoteWorkspace=false` 门禁保持）。

## 术语

| 用户看到的词 | 含义 |
| --- | --- |
| 直连 / 直连设备 | 按 IP 与端口直接连接的电脑；类型标签与连接描述使用 |
| 配对码 | 被控机 `zcode serve pair` 输出的一次性验证码，用于首次换取设备 Token |
| 设备 Token | 配对成功后签发的长期凭据，控制端保存、被控端只存哈希 |
| ZCode Server | 被控端 `zcode serve` 进程，沿用既有术语 |

禁止出现在界面上的词：ingress token、capability、直连接口、Server 直连（旧 dev 命名）、`kind:"server"`。

## 被控端（zcode serve）

### 监听与配置

- 默认行为不变：监听 `127.0.0.1` 动态端口。
- 非回环监听必须显式配置：CLI `--host <ip|0.0.0.0>` 与 `--port <n>`；配置了非回环 host 但未给端口时 fail-fast，不静默换端口。生效链路为 CLI > 配置文件 > 默认。
- 新增配置文件 `<serverRoot>/server-config.json`（`{"listen":{"host":"...","port":N}}`），与 CLI flag 同时生效、随服务保留；`serve --daemon` 把生效监听参数注入服务 descriptor，重装服务不丢配置。
- 非回环监听强制启用鉴权：无法启用 token 校验时拒绝启动（fail-closed 现有拦截的语义从「一律禁止非回环」改为「非回环必须带鉴权」）。
- `status --json` 增加 `listenHost` / `listenPort` / `pairingReady` 字段；任何命令与输出都不回显 Token 或配对码以外的机密。

### 配对码

- `zcode serve pair`（被控机本地命令）向运行中的 Core 请求一次性配对码；有效期 10 分钟、一次性消费、同时最多 3 个未消费码；连续错误尝试触发退避（1 分钟内至多 5 次，超限临时冻结配对）。
- 配对码为 ≥40 bit 熵的随机串，展示时大小写不敏感归一。生成只经被控机本地命令（`zcode serve pair`，控制面 IPC）；消费入口为 `POST /api/pair`，接受局域网 peer 请求，安全性由码熵、一次性消费、TTL 与失败退避共同保证，不要求预先鉴权。
- 输出为可复制文本块：地址、端口、配对码与有效期。不做二维码（控制端无扫码场景）。

### 设备 Token

- 配对成功即签发长期设备 Token：≥32 字节随机；服务端只存 SHA-256 哈希，落 `<serverRoot>/devices.json`（0600），字段 `id / name / tokenHash / createdAt / lastSeenAt / revokedAt`。设备 Token 跨 Core 重启有效，不参与启动轮换。
- 与 ingress token 职责分离：ingress token 继续服务受管 SSH / WSL / Docker 部署通道，文件与轮换语义不变；设备 Token 只新增、不替换。两者经同一 middleware 校验（timingSafeEqual），401 响应携带稳定错误码供控制端分类。
- 管理命令：`zcode serve tokens`（列出 id、name、lastSeenAt、状态，不显示 Token）、`zcode serve tokens revoke <id>`、`zcode serve tokens revoke --all`；吊销立即生效。已配对设备上限 16，超出需先吊销。
- 非回环监听启动时输出一次告警：监听地址、端口、已配对设备数。

### 安全

- 配对端点限流与失败退避见上；局域网明文 `ws` 与现状 ingress 通道同级，文档注明公网场景的 TLS 由反向代理承担（统一计划 §7.1），本期不做产品化 TLS 配置。

## 控制端

### 入口与菜单落位

不新增菜单、弹窗或设置分区。直连是统一连接向导内的第四种连接类型，四个既有入口全部复用：

1. 聊天头部 workspace chip 菜单 →「新建远程连接…」；
2. 项目创建/编辑对话框设备下拉 →「添加远程设备…」；
3. 设置 › 远程设备 →「新建连接」；
4. 设备卡 / 侧栏既有连接与重连入口。

选择屏底部新建按钮组增加第四项「直连局域网电脑」；删除 dev-only 提示与「开发 Server」命名。已保存的直连设备与其他设备同组展示（图标 + 类型标签 + 五态 + 最近目录 chip）。

### 类型体系补全（消除散落分支）

- 连接类型枚举纳入 `server`；`REMOTE_KIND_PRESENTATION` 增加 server 类型 token（新增设计 token，取值避开语义色与既有类型色）；`RemoteConnectionKindTag`、向导头预览、连接中屏标题统一走类型标签，删除裸文本与跳过分支。
- 类型图标改用 Network；CloudIcon 与五态状态云语义冲突，弃用。
- 展示投影连接描述由 `HTTP · url` 改为 `直连 · host:port`。

### 向导各屏

- 表单屏沿用 RDUX-27 排布：主机与端口并排一行；「配对码」字段（粘贴被控机 `zcode serve pair` 的输出）；可选设备名；可选默认目录。不提供手填 Token 字段，凭据只经配对产生。
- 连接屏阶段：建立直连通道 → 验证配对码 → 识别设备 → 启动连接。配对码错误或过期就地显示在配对阶段，可改码重试，不回退到表单整屏。
- 连接成功复用目录屏与既有 workspace 打开链路（该路径本无 server 专属分支，保持）。

### 设备管理（设置页）

- 直连设备进入设置 › 连程设备同一设备列表：五态、连接行（`直连 · host:port`、远端版本、最近在线）、最近项目、其他连接、最近日志、编辑（名称、默认目录）、移除，全部与既有设备一致。
- 管理快照扩展：server 直连的状态投影进入统一展示模型输入，不允许 UI 自行计算旁路分支。
- 移除设备对话框区分两级语义：默认只移除本机记录与凭据；可勾选「同时在远程电脑上撤销此配对」（需在线，走被控端吊销）。对话框明示本机移除不停用对方配对记录。

### 错误分类扩展

| 错误码 | 触发 | 可见状态 | 修复操作 |
| --- | --- | --- | --- |
| `remote-pairing-code-invalid` | 配对码错误 / 过期 / 已消费 | 连接失败（配对阶段内联） | 改码重试 |
| `remote-device-revoked` | 设备 Token 已吊销或服务端重置 | 需要处理 | 重新配对 |
| `remote-auth-required` | 其他 401 | 需要处理 | 重新配对 |
| 版本不兼容 | 握手阶段 | 需要处理 | 沿用既有更新分类 |

中英文文案同步；分类进入 `classifyRemoteConnectionError`，不得落到「未知」。

### 自动重连

- 直连设备接入既有断线恢复框架：退避 + 预算 + 启动批次，受 `remoteStartupAutoReconnectEnabled` 门禁。
- `remote-device-revoked` / `remote-auth-required` 不参与重试，直接转「需要处理 · 重新配对」。

## 配对与时序

```text
被控机                                  控制机
zcode serve --host <ip> --port <n>
zcode serve pair ─ 生成配对码（10min，一次性，≤3 个未消费）
   │ 抄码
   ▼
                     向导表单（地址 + 端口 + 配对码）
                       POST /api/pair {code}
                         ├ 限流 / 退避 / 一次性消费
                         └ 签发设备 Token（只存 hash）
                     <── deviceToken + serverId + hostname + version
                       credentialService 保存（remote-server:<hostId>:token）
                       既有链路 /api/server-info → capability → /ws/host（token 经 middleware）
断线 ── 退避重连（预算内）──> 401 revoked ──> 需要处理 · 重新配对（不重试）
```

## 不变量

- 不改 workspace identity、remoteSessionId、单 Window Host、desktop-continuous / web-remote-replayable 边界。
- 不为直连新建 Desktop Remote Host 或独立会话链路；直连复用既有 server-remote 握手与 attachment 流程。
- 手机远控 relay 链路与配置不变；ingress token 受管通道语义不变。

## 分阶段实施

- P1 被控端：监听配置、配置文件、descriptor 注入、配对码、设备 Token、middleware、管理命令、启动告警。
- P2 控制端连接链路：配对消费、凭据保存、401 分类、自动重连接入。
- P3 UI 产品化：类型体系补全、四入口露出、向导三屏、设置设备卡、中英文文案。
- P4 验收与收口：安全回归（fail-closed、限流、吊销）、系统防火墙首次监听提示文案、README 与 UX 规格同步。

## 验收场景

1. 默认启动只监听回环；`--host 0.0.0.0` 未给 `--port` 拒绝启动；非回环启动必然带 token 校验。
2. 配对码 10 分钟过期、一次性消费、并发上限 3；错误尝试触发退避。
3. 配对成功后重启 `zcode serve`，直连设备凭据仍有效（ingress token 轮换不影响）。
4. `tokens revoke` 后下一次请求 401，控制端进入「需要处理 · 重新配对」且不参与自动重连。
5. 四入口均可发起直连；类型切换含第四项；连接屏走四个阶段；配对码错误在配对阶段内联可重试。
6. 设置页直连设备卡与 SSH 设备卡同构：五态、最近项目、其他连接、最近日志、编辑、移除两级语义。
7. 手机 / Web 端不出现直连入口；手机远控链路回归不受影响。
8. 界面与命令输出不出现禁止词；Token 不进日志与提交。
