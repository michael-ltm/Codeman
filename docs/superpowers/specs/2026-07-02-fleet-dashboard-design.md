# Codeman Fleet Dashboard — 设计文档(修订版)

日期:2026-07-02
状态:已确认(用户批准架构方案 A + 分屏网格进 MVP)
取代:`codeman-central-dashboard-plan.md` 中的架构假设部分(该文件将按本设计修订为实施计划)

## 1. 目标与优先级

一个固定 LAN/Tailscale URL(macmini `:3100`)呈现所有已加入设备、每台在线设备的全部活动会话,并在**同一页面内**打开/控制任意设备的会话。

用户明确的优先级排序:
1. **多设备同时管理和查看**(含分屏同屏多终端,MVP 必须有)
2. 用户体验好(操作密集型 dashboard,非营销页风格)
3. 单页原则:绝不跳转到各设备独立 UI

## 2. 架构决策(已确认)

### 2.1 方案 A:node agent 嵌入 `codeman web`

设备端照常运行 `codeman web`(可绑 loopback)。`WebServer.start()` 末尾检测 `dataPath('fleet-node.json')` 存在则在**同进程**启动 `FleetNodeAgent(ctx, config)`,agent 通过现有 route context(`createRouteContext()`,server.ts:554)直接操作 `Map<string,Session>`、mux、持久化与恢复逻辑。

**否决的替代方案:**
- 独立 headless 进程自建 `LocalSessionController`(原 plan Task 5):复刻会话构建/持久化/恢复约 500 行,且设备同时跑本地 web UI 时双进程共写 `state.json` 与 tmux 会话,产生冲突。**原 Task 5 整体删除。**
- 中央实现远程 `SessionPort` 复用现有路由处理器:接口面过大(server.ts 2497 行拼出的 ports),把远程延迟/离线塞进为本地同步设计的接口是错误抽象。

`codeman node run` 保留为**薄别名**:等价于启动绑 `127.0.0.1` 的 web server(含 agent),不引入第二套会话栈。

### 2.2 统一设备抽象:`FleetDeviceHandle`

```ts
interface FleetDeviceHandle {
  readonly deviceId: string;
  summary(): FleetDeviceSummary;
  listSessions(): Promise<FleetSessionSummary[]>;
  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary>;
  stopSession(sessionId: string): Promise<void>;
  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void;
  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void;
  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void; // 返回退订函数
  getTerminalBuffer(sessionId: string): Promise<string>;
}
```

- **中央自身** = `LocalDeviceAdapter implements FleetDeviceHandle`,进程内直调自己的 ctx。macmini 的本地会话与远程设备在 dashboard 中同构呈现,不走 WS 回环。
- **远程设备** = `RemoteDeviceHandle`(由 `FleetCentralController` 内部管理),封装节点 WS + RPC。
- Dashboard/路由层代码只面向 `FleetDeviceHandle`,不区分本地远程。

### 2.3 状态推送:复用现有 SSE

不新建轮询或独立 WS。中央通过现有 `ctx.broadcast` + SSE `/api/events` 推送新事件:
- `fleet:device-online` / `fleet:device-offline`
- `fleet:sessions-updated`(携带该设备最新会话摘要列表)

前端在 `constants.js` 的 `SSE_EVENTS` 注册表(须镜像 `src/web/sse-events.ts`)中登记并处理。验收"上下线 15 秒内更新"实际达到秒级。

### 2.4 节点认证:HTTP 头,不用 query 串

节点出站 WS 连接 `/ws/fleet/node` 携带:
```
Authorization: Bearer <long-lived-token>
X-Codeman-Device-Id: <deviceId>
```
理由:query 串会进访问日志;代码库已有 header 凭证先例(`X-Codeman-Hook-Secret`,auth.ts:116)。

## 3. 协议

### 3.1 常量与基础类型

沿用原 plan 的 `FLEET_PROTOCOL_VERSION = 1`、`FleetDeviceStatus`、`FleetSessionStatus`、`FleetSessionMode`(与 `src/types/session.ts:44` 的 `SessionMode` 对齐:`claude|shell|opencode|codex|gemini`)、`FleetDeviceSummary`、`FleetSessionSummary`、`FleetSessionTab`、`CreateFleetSessionRequest`、`FleetDashboardState`。全部配 zod schema。

### 3.2 节点 ↔ 中央帧(修订)

```ts
export type NodeToCentralFrame =
  | { t: 'hello'; protocol: 1; device: FleetDeviceSummary; sessions: FleetSessionSummary[] }
  | { t: 'heartbeat'; sessions: FleetSessionSummary[] }        // 10s 一次,全量对账
  | { t: 'session:update'; session: FleetSessionSummary }
  | { t: 'terminal:data'; sessionId: string; data: string }     // 节点侧已 8ms 批量
  | { t: 'terminal:clear'; sessionId: string }
  | { t: 'terminal:refresh'; sessionId: string }                // 只发信号,缓冲走 RPC 拉取
  | { t: 'ack'; requestId: string; data?: unknown }
  | { t: 'error'; requestId?: string; message: string };

export type CentralToNodeFrame =
  | { t: 'list-sessions'; requestId: string }
  | { t: 'create-session'; requestId: string; payload: CreateFleetSessionRequest }
  | { t: 'stop-session'; requestId: string; sessionId: string }
  | { t: 'get-buffer'; requestId: string; sessionId: string }   // 新增:按需拉缓冲
  | { t: 'terminal:subscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:unsubscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:input'; sessionId: string; data: string; seq?: number; cid?: string }
  | { t: 'terminal:resize'; sessionId: string; cols: number; rows: number; viewportType?: string; force?: boolean };
```

相对原 plan 的变化:
- `terminal:refresh` 不再内嵌 `buffer`(大缓冲会阻塞多路复用的 node WS),改为信号 + `get-buffer` RPC 按需拉取。
- 新增 `get-buffer`;`terminal:resize` 增加 `viewportType` 以透传现有尺寸仲裁语义。
- 认证信息移出 URL(见 2.4)。

### 3.3 浏览器 ↔ 中央终端帧

与本地终端路由(ws-routes.ts:19)**完全一致**:客户端 `{t:'i',d,seq,cid}` / `{t:'z',c,r,f,v}`;服务端 `{t:'o',d}` / `{t:'c'}` / `{t:'r'}` / `{t:'ia',seq}`。前端可最大化复用 `app.js` 的 `_connectWs` / `_reliableSend` 机制。

## 4. 数据流

### 4.1 配对
1. Dashboard `POST /api/fleet/pairing-codes` → `{code, expiresAt, joinCommand}`(8 位,排除 `0O1I`,10 分钟,一次性)。
2. 设备执行 `codeman node join <central-url> --code <code> [--name <n>]` → `POST /api/fleet/pair`(**豁免 Basic Auth,配对码即凭证,按 IP 速率限制**)→ `{deviceId, token}` → 写 `fleet-node.json`(POSIX `0600`)→ 提示重启 `codeman web` 或运行 `codeman node run`。
3. 中央只存 token 的 SHA-256;明文仅存节点本地。

### 4.2 节点上线/离线
- agent 连接 → 首帧必须 `hello` → `registry.markOnline` → SSE `fleet:device-online`。
- 心跳 10s(带全量会话列表对账);socket 关闭 → `markOffline` → SSE `fleet:device-offline` → 该设备所有浏览器终端 WS 以 `4009` 关闭。
- 重连退避 1s→30s,免重新配对;中央重启后节点自动恢复。

### 4.3 远程终端
1. 浏览器连 `/ws/fleet/devices/:deviceId/sessions/:sessionId/terminal`(继承 Host/Origin 守卫 + 认证 cookie)。
2. 中央 `subscribeTerminal(deviceId, sessionId, sink)` **引用计数**:首个订阅者触发向节点发 `terminal:subscribe`,归零才发 `unsubscribe`。多浏览器/多格子看同一会话共享一路节点流。
3. 节点 agent 将 ws-routes.ts:172 的会话事件订阅逻辑(`terminal|clearTerminal|needsRefresh|exit` + 8ms 批量/16KB 阈值)复用于 WS 转发。
4. 输入:`{t:'i',d,seq,cid}` 端到端透传 → 节点 `session.shouldApplyInput(cid,seq)`(session.ts:2283)去重,至多一次写入;中央转发成功即回 `ia`(重复投递被节点端幂等吸收)。
5. 缓冲:浏览器收 `{t:'r'}` → `GET /api/fleet/devices/:d/sessions/:s/terminal` → 中央 RPC `get-buffer` → 节点用与 `GET /api/sessions/:id/terminal`(session-routes.ts:983)相同的重建逻辑。本地设备直调。

### 4.4 RPC
`request()`:自动分配 `requestId`,匹配 `ack` resolve、`error` reject,10s 超时(REST 层映射:超时 → 504;设备离线 → 409 `Device is offline`)。

## 5. REST API

```
GET    /api/fleet                                  → FleetDashboardState
GET    /api/fleet/devices                          → { devices, sessions }(排序:在线优先→有活动会话优先→lastSeenAt 降序)
POST   /api/fleet/pairing-codes                    → { code, expiresAt, joinCommand }
POST   /api/fleet/pair                             → { deviceId, token }(豁免 Basic Auth)
POST   /api/fleet/devices/:deviceId/sessions       → 创建会话(离线 409)
DELETE /api/fleet/devices/:deviceId/sessions/:sessionId
GET    /api/fleet/devices/:deviceId/sessions/:sessionId/terminal → { buffer }
```

`sessionTabs` 映射(沿用原 plan):
```ts
const key = `${deviceId}:${sessionId}`;
const deviceName = device.name || device.hostname || device.id.slice(0, 8);
const sessionLabel = session.name || basename(session.workingDir) || session.id.slice(0, 8);
const title = `${deviceName} / ${sessionLabel}`;
```
同名会话保持独立 Tab(key 是稳定身份)。

## 6. 前端(Rev 3 融入式重写 — 2026-07-02 用户否决平行界面后修订)

> 历史:Rev 2 实现为独立 `#fleet-dashboard` 平行界面(隐藏原 `.app`),用户验收否决:"太丑、原仓库 UI 基本没了,要在原 UI 基础上实现,并兼容移动端"。Rev 3 原则:**远程会话是原 UI 的一等公民,不存在第二个界面。**

### 6.1 融入原则
- **没有独立 dashboard 页面**。原 Codeman UI 是唯一界面;删除平行界面(`fleet-dashboard.js` 的 UI 层重写,`fleet-api.js` 保留为纯 API 层)。
- **远程会话进现有 session tab 条**:与本地 tab 混排,内部 key = `${deviceId}:${sessionId}`,可见标签 `设备名 / 原标签` + 在线状态点 + 模式徽标;本地会话的 tab 行为分毫不动。关远程 tab 只影响本地可见性;停远程会话是显式操作。
- **远程终端复用现有终端组件**:点远程 tab 后由现有 terminal-ui 渲染;仅将 WS URL、缓冲 URL、HTTP 输入回退 URL 按 tab 类型参数化切换到 fleet 端点(`/ws/fleet/devices/:d/sessions/:s/terminal`、`GET/POST /api/fleet/devices/:d/sessions/:s/terminal|input`)。xterm 管线、防闪烁、local echo、移动端键盘 accessory、CJK 输入全部自然继承。
- **主题**:一切新增元素只用现有 CSS 变量,自动跟随 `data-skin` 主题;不引入自有配色。

### 6.2 设备面板(panels-ui 风格)
- 侧面板,与 subagents 等现有面板同一交互习惯:设备列表(状态灯/平台/hostname/活动会话数/`⚠ 无 tmux` 能力标)、生成配对码(码+过期倒计时+可复制 join 命令)、远程新建会话(设备选择默认当前、offline 禁选;workingDir 必填;mode 分段控件)。
- 头部入口按钮 + 在线设备数 badge;移动端**保留**该按钮(核心功能,不同于 away-digest 的桌面-only 策略)。
- 点设备只更新面板内选中态,绝不跳转。

### 6.3 分屏网格(桌面/平板;手机不做)
- 布局 `1 / 2 / 2×2`,tab 可钉入格子;每格独立 xterm + 独立 WS 绑定 tab key,输入按格路由。
- 样式完全使用现有设计变量与主题;尺寸仲裁沿用 `claimDesktopSizing`;护栏:同屏 ≤4 格、单浏览器 fleet 终端 WS ≤6、格内 canvas 渲染。
- **手机(mobile.css 手机断点)不提供网格**:单终端 + tab 切换;平板/桌面可用。
- 掉线/非用户关闭 → 格内明确遮罩;设备回线自动重连(沿用 Rev 2 已实现的语义)。

### 6.4 移动端
- 远程 tab 与设备面板按 mobile.css 既有断点适配;文本不溢出。
- 远程终端在移动端的行为 = 本地终端(同一组件),包括键盘 accessory 与手势。

### 6.5 状态更新
- 走现有 SSE 连接(`fleet:device-online/offline`、`fleet:sessions-updated`)驱动 tab 条与设备面板刷新;首屏无需 `CODEMAN_FLEET_DASHBOARD` 开关(远程 tab 有则显示,无则界面与原版无异)。

### 6.6 补充后端件
- `POST /api/fleet/devices/:deviceId/sessions/:sessionId/input`(body 同本地 input 端点:`{input, seq, clientId}`),供远程 tab 的可靠输入 HTTP 回退;转发为 `terminal:input` 帧,继承节点端 `shouldApplyInput` 幂等。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 节点 tmux 缺失(Windows 无 WSL) | `capabilities.tmux=false` → dashboard 禁用创建并显示能力提示 |
| 浏览器观看中节点掉线 | 终端 WS `4009` 关闭;设备留列表转灰,操作禁用 |
| 会话疯狂输出 | 节点检查 `socket.bufferedAmount > 512KB` 丢输出批次,恢复后发 `terminal:refresh` 让浏览器重拉缓冲(丢帧不丢数据) |
| RPC 超时 | 10s → REST 504;设备离线 → 409 |
| 配对码过期/复用 | 明确错误;dashboard 一键重新生成 |
| 未知设备/会话 | 浏览器终端 WS 关闭码 `4004` |

## 8. 安全

- 浏览器侧 fleet REST/WS 继承现有 Basic Auth(`CODEMAN_PASSWORD`)+ Host/Origin 双守卫(同 ws-routes.ts 模式)。
- 豁免仅两处:`POST /api/fleet/pair`(配对码即凭证 + IP 速率限制)、`/ws/fleet/node`(Bearer token 即凭证)。
- token 明文只在节点 `fleet-node.json`(0600);中央只存哈希。不提交任何密钥/launchd 密码/`~/.codeman` 运行态。
- 无未认证 LAN 发现端点;首版无远程文件浏览。
- 非 loopback 绑定必须设置 `CODEMAN_PASSWORD`。

## 9. 测试策略

- `test/fleet/protocol.test.ts` — zod schema 往返。
- `test/fleet/device-registry.test.ts` — 码一次性/过期/token 哈希验证/离线保留/临时文件重载。
- `test/fleet/node-config.test.ts` — 读写 + 0600。
- `test/fleet/device-adapter.test.ts` — `LocalDeviceAdapter` 对 mock ctx(`test/mocks/mock-route-context.ts` 既有设施)。
- `test/fleet/central-controller.test.ts` — RPC 超时/ack/error、订阅引用计数、上下线。
- `test/routes/fleet-routes.test.ts` — `createRouteTestHarness()`(test/routes/_route-test-utils.ts:26)+ mock controller。
- `test/routes/fleet-ws-routes.test.ts` — 真实 Fastify + 监听端口模式(照 ws-routes.test.ts:82),覆盖节点认证失败、hello 强制首帧、输出/输入/resize 转发、离线 4009、清理。
- 可选 e2e:同机双进程,用不同 `CODEMAN_INSTANCE`(隔离数据目录 + tmux socket,src/config/instance.ts:36)烟测 `echo fleet-ok`。

## 10. 对既有实施计划的修订清单

原 `codeman-central-dashboard-plan.md` 需要的改动:
1. **Task 1**:目录已含本设计文档与 plan 文件,`gh repo clone` 到非空目录会失败 → 改为 `git init + remote add + fetch + checkout` 流程。
2. **Task 2**:默认端口 3000 共 **3 处**(cli.ts:580、server.ts:292 WebServer 构造器、server.ts:2486 startWebServer)。
3. **Task 3**:协议帧按本文 §3.2 修订。
4. **Task 4**:`node join` 不变;`node run` 改为薄别名(loopback web server + agent)。
5. **Task 5**:删除 `LocalSessionController`,替换为 `device-adapter.ts`(`FleetDeviceHandle` + `LocalDeviceAdapter`)。
6. **Task 6**:agent 构造参数为 ctx;节点 WS 认证改 Bearer 头;中央订阅加引用计数。
7. **Task 7**:`/api/fleet/pair` 豁免认证需在 auth 中间件登记;新增 `get-buffer` 转发。
8. **Task 9**:拆 9a(dashboard 核心 + 单终端聚焦)/ 9b(分屏网格,MVP 内);SSE 事件登记。
9. **全文**:删除"`Session.start()` 是 legacy"的说法(该方法不存在);入口为 `runPrompt()` / `startInteractive()`(session.ts:1254)/ `startShell()`(session.ts:1615)。
10. 依赖:`ws` 需显式加入 dependencies(现仅为传递依赖);`zod`、`node-pty` 已有。

## 11. 范围外(YAGNI)

- 远程文件浏览、远程 ralph/orchestrator/respawn 面板(fleet 首版只做会话查看/创建/停止/终端)。
- 设备自动发现(mDNS 等)。
- 中央高可用/多中央。
- 非 tmux 终端后端(`createMultiplexer()` 硬依赖 tmux,mux-factory.ts:15)。

## 12. Rev 4 追加(2026-07-03 用户验收反馈):跨设备 Resume + 左侧会话列表 + 工作目录选择

### 12.1 协议扩展
- `CentralToNodeFrame` 新增:`{t:'list-resume-candidates', requestId}` → ack data `ResumeCandidate[]`(`{sessionId, workingDir, title, updatedAt, projectKey?}`,复用本地 `/api/history/sessions` 的同一核心逻辑);`{t:'list-dirs', requestId, path}` → ack data `{path, dirs: string[]}`。
- `CreateFleetSessionRequest` 新增 `resumeSessionId?: string`(仅 claude 模式;透传至 `createSessionCore` 的既有 resumeSessionId 输入)。
- **list-dirs 安全约束(节点端强制)**:realpath 解析后必须仍在 `$HOME` 内(拒绝符号链接逃逸);只返回目录名(绝不返回文件内容/文件名);单次一层;条目数上限 200;隐藏目录(`.` 开头)默认排除。中央 REST 面走正常浏览器认证,不豁免。

### 12.2 REST
- `GET /api/fleet/devices/:deviceId/resume-candidates` → `{ candidates }`(本地设备经 LocalSessionOps 直调同一核心)。
- `GET /api/fleet/devices/:deviceId/dirs?path=` → `{ path, dirs }`(离线 409;path 缺省 = `$HOME`)。
- `POST /api/fleet/devices/:deviceId/sessions` 接受 `resumeSessionId`。

### 12.3 跨设备 Resume UI
- 欢迎页 Resume Conversation 列表混排所有在线设备的候选,**条目带设备 chip**(`设备名`,本机不带或标"本机");按 updatedAt 全局降序。
- 点远程条目 → 在对应设备以 claude 模式 + 该 workingDir + resumeSessionId 创建会话,自动出现在 tab 条并选中。
- 本地条目的既有行为逐字节不变(红线);设备离线的候选不显示(或置灰)。

### 12.4 左侧会话列表布局(桌面/平板;手机不变)
- App Settings → Display 新增"会话列表位置:顶部 / 左侧"(加入 per-device displayKeys,不跨设备同步)。
- 左侧模式:竖排会话列表(本地+fleet 同一数据源与顺序),显示状态点/模式徽标/设备名前缀,宽度固定可滚动;顶部 tab 条隐藏;终端区相应让位。切回顶部即还原。手机断点忽略该设置。

### 12.5 工作目录选择(设备面板新建会话表单)
- **智能下拉**:候选 = 该设备现有会话 workingDir ∪ resume 候选 workingDir,去重、按最近使用降序;仍可手输任意路径。
- **目录浏览**:表单旁"浏览…"按钮 → 应用模态框逐级浏览(list-dirs 驱动,面包屑导航,选中即回填);本地设备走同一 UI(local handle 直调)。禁原生对话框。

## 13. Rev 5 排队(2026-07-03 用户确认):外部 tmux 会话收编

用户诉求:自己在终端开的 tmux claude/codex 会话,Codeman 自动发现并作为 tab 显示、可看可输入。三个已确认决策:仅 tmux 收编(裸终端不做)、完整交互、全部 fleet 节点扫描。

### 13.1 发现
- 每个节点(含中央本机)周期扫描:枚举候选 tmux socket(默认 socket `/tmp/tmux-<uid>/default` + `CODEMAN_ADOPT_SOCKETS` 配置的额外 socket;**排除自己的 codeman socket**),对每个 session 检查 pane 进程树是否含 claude/codex/gemini/opencode 可执行名。
- 产出 `ExternalSessionCandidate { socket, tmuxSession, mode, workingDir(pane cwd), firstSeenAt }`,经协议扩展上报中央(heartbeat 附带或独立帧),SSE 推送。

### 13.2 收编语义(安全红线)
- 收编 = 在既有 Session 抽象上以"外部宿主"模式 attach(`tmux -L <socket> attach -t <session>` 的 PTY 包装);tab 显示 `设备名 / tmux:<会话名>` + 收编标记。
- **绝不接管生死**:关 tab 仅 detach;不提供停止按钮;Codeman 的清理/驱逐/respawn 一律不得 kill 外部会话(`CODEMAN_MUX` 安全约束同源);不写入其环境。
- 收编会话不参与 respawn/ralph 等 Claude 专属自动化(与外部 CLI 模式同等豁免)。

### 13.3 UI
- 设备面板新增"发现的外部会话"区:列表 + "收编为 Tab"按钮;收编后与普通 fleet tab 同权(终端/输入/分屏可钉)。
- 全 fleet:候选与已收编状态经中央聚合,设备前缀一致。
