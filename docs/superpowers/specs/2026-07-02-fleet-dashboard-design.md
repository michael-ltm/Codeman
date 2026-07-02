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

## 6. 前端(MVP 含分屏网格)

### 6.1 布局
- **全局 Tab 条**:所有设备的活动会话,标签 `设备名 / 原标签`,状态点 + 模式标记;关 Tab 只影响本地可见性,停会话需显式操作。
- **设备栏**(左列或顶带):状态灯、平台、hostname、活动会话数;点击更新页内选中态,**绝不跳转**。
- **终端区**:布局三档 `1 / 2 / 2×2`,Tab 可"钉到格子"。
- **配对抽屉**:码 + 过期时间 + 可复制 join 命令;空态"No devices joined"+ 配对按钮。
- 会话列表默认显示活动会话(`idle|busy|error`),`stopped` 藏在"显示历史"开关后。

### 6.2 分屏网格(MVP,任务 9b)
- 每格 = 独立 xterm 实例 + 独立 WS,绑定 `FleetSessionTab.key`,输入按格路由,结构上不可能串设备。
- 每格按自身 fit 尺寸发 `{t:'z',c,r,v:'desktop'}`,同会话多视图冲突由现有 `claimDesktopSizing`(session.ts:2365,90s 空闲仲裁)处理,不新增机制。
- 护栏:同屏 ≤4 格;格内 xterm 用 canvas 渲染(webgl 留给单终端聚焦视图);中央限制单浏览器 fleet 终端 WS 并发 ≤6。
- 重连:仅当设备仍在线时自动重连;掉线格显示明确的 offline 提示。

### 6.3 与现有 UI 的关系
- 现有本地会话视图保持可用;fleet dashboard 在 `GET /api/fleet` 有已加入设备或 `CODEMAN_FLEET_DASHBOARD=1` 时成为首屏。
- 状态更新走现有 SSE 连接,新增 `fleet:*` 事件处理器。
- CSS:操作密集型、卡片圆角 ≤8px、无 hero、移动端文本不溢出、避免单调紫/深蓝配色。

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
