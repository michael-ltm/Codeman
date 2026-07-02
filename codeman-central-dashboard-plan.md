# Codeman Fleet Dashboard Implementation Plan (Rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-02-fleet-dashboard-design.md` — 本计划的所有决策以该 spec 为准。本文件取代 Rev 1(原 `codeman-central-dashboard-plan.md`)。

**Goal:** 一个固定 LAN/Tailscale URL(macmini `:3100`)呈现所有已加入设备与其全部活动会话,并在同一页面内查看/控制任意设备的会话,MVP 含 1/2/2×2 分屏网格。

**Architecture:** 方案 A——`FleetNodeAgent` 嵌入现有 `codeman web` 进程,通过 route context 复用现有 Session/mux/持久化栈(**不自建会话栈**)。中央通过统一的 `FleetDeviceHandle` 抽象聚合本地设备(`LocalDeviceAdapter`,进程内直调)与远程设备(节点出站 WS)。浏览器状态更新复用现有 SSE `/api/events`。

**Tech Stack:** TypeScript (ESM), Fastify 5, `@fastify/websocket`, `ws`(新增直接依赖), zod 4, 现有 `Session` + tmux mux 层, vanilla JS + vendored xterm.js 前端, Vitest。

## Global Constraints

- 开发仓库路径:`/Users/ming/Documents/code/ai/codeman`(目录非空:含本计划与 spec,**不能直接 `git clone`**,见 Task 1)。
- 上游:`https://github.com/Ark0N/Codeman.git`,基线 commit `1fa88cd1877f80536fca38bcf4ad1667ad286fff`;fork:`michael-ltm/Codeman`。
- 默认 web 端口 `3100`(默认值 `3000` 共 **3 处**:`src/cli.ts:580`、`src/web/server.ts:292`、`src/web/server.ts:2486`)。
- 单页原则:设备卡片点击只更新页内状态,绝不跳转到独立远程 UI。
- 全局 Tab:key = `${deviceId}:${sessionId}`,可见标签 = `设备名 / 原标签`;同名会话保持独立 Tab。
- 配对码:8 位,字母数字排除 `0 O 1 I`,10 分钟过期,一次性;中央只存设备 token 的 SHA-256,明文只在节点 `fleet-node.json`(0600)。
- 节点只出站连接;认证用 `Authorization: Bearer <token>` + `X-Codeman-Device-Id` 头,**不放 query 串**。
- 浏览器侧 fleet REST/WS 继承现有 Basic Auth + Host/Origin 守卫;豁免仅 `POST /api/fleet/pair` 与 `/ws/fleet/node`。
- 分屏网格进 MVP:布局 1/2/2×2,同屏 ≤4 格,单浏览器 fleet 终端 WS 并发 ≤6。
- 不提交任何密钥、本机密码、`~/.codeman` 运行态、含真实密码的 launchd plist。
- 跨平台 macOS/Linux/Windows;tmux 缺失(如无 WSL 的 Windows)时 `capabilities.tmux=false`,UI 显示能力错误而非装死。
- 所有 `/api/*` 响应被 `preSerialization` 钩子包为 `{success:true,data}`(`server.ts:646`)——**CLI 与测试解析响应时必须解包 `data`**。

## Verified Codebase Facts(勘探已确认,直接引用)

- `Session` 没有 `start()` 方法;入口是 `runPrompt()` / `startInteractive()`(session.ts:1254)/ `startShell()`(session.ts:1615)。
- 会话管理不是独立类:`WebServer` 持有 `Map<string,Session>`,`createRouteContext()`(server.ts:554)拼出 SessionPort/EventPort 等 port 接口给路由。
- 本地终端 WS 协议(ws-routes.ts:19):入 `{t:'i',d,seq,cid}` / `{t:'z',c,r,f,v}`;出 `{t:'o',d}` / `{t:'c'}` / `{t:'r'}` / `{t:'ia',seq}`;8ms 批量 / 16KB 阈值;`session.shouldApplyInput(cid,seq)`(session.ts:2283)端到端去重。
- Host/Origin 守卫:`isAllowedRequestHost` / `isAllowedRequestOrigin`,ws-routes 经 `getHostPolicy()` 注入 `{bindHost, allowedHosts, tunnelHost}`。
- SSE:`/api/events`(server.ts:749)+ `ctx.broadcast`;事件名注册于 `src/web/sse-events.ts`,前端镜像在 `public/constants.js` 的 `SSE_EVENTS`。
- 认证:`src/web/middleware/auth.ts` —— Basic Auth 由 `CODEMAN_PASSWORD` 开关(auth.ts:52),cookie `codeman_session`;loopback 免认证先例见 auth.ts:116-140(hook-secret 模式)。
- 数据目录:`dataPath(...)`(src/config/instance.ts:64);`CODEMAN_INSTANCE` 同时隔离数据目录与 tmux socket(instance.ts:36)——e2e 双进程靠它隔离。
- 测试设施:HTTP 路由用 `createRouteTestHarness()`(test/routes/_route-test-utils.ts:26)+ `createMockRouteContext()`(test/mocks/mock-route-context.ts);WS 路由用真实 Fastify 监听端口模式(ws-routes.test.ts:82-90,client 用 `ws` 包)。
- 依赖:`zod ^4`、`node-pty` 已有;**`ws` 只是传递依赖,需显式加入 dependencies**。
- `createMultiplexer()`(mux-factory.ts:15)硬依赖 tmux,不可用即 throw。

## File Structure

- Modify: `package.json` — dependencies 增加 `"ws": "^8"`(Task 8)。
- Modify: `src/cli.ts` — 端口默认值;新增 `codeman node join` / `codeman node run`。
- Create: `src/config/server-defaults.ts` — `DEFAULT_CODEMAN_PORT = 3100`。
- Create: `src/fleet/protocol.ts` — 全部帧类型 + zod schema + `buildFleetSessionTab`。
- Create: `src/fleet/device-registry.ts` — 配对码 + token 哈希 + 设备记录,持久化 `dataPath('fleet-devices.json')`。
- Create: `src/fleet/node-config.ts` — `fleet-node.json` 读写(0600)。
- Create: `src/fleet/local-session-ops.ts` — `LocalSessionOps`:fleet 侧唯一接触 Session/ctx 内部的模块。
- Create: `src/fleet/device-adapter.ts` — `FleetDeviceHandle` 接口 + `LocalDeviceAdapter`。
- Create: `src/fleet/central-controller.ts` — `FleetCentralController` + 内部 `RemoteDeviceHandle`(RPC、订阅引用计数、状态缓存)。
- Create: `src/fleet/node-agent.ts` — `FleetNodeAgent` 出站 WS client(心跳、重连退避、终端批量/背压)。
- Modify: `src/web/route-helpers.ts` — 抽取 `createSessionCore` / `readSessionTerminalBuffer` / `deleteSessionCore`(Task 6)。
- Create: `src/web/routes/fleet-routes.ts` — REST。
- Create: `src/web/routes/fleet-ws-routes.ts` — 节点 WS + 浏览器远程终端 WS。
- Modify: `src/web/routes/index.ts` — 导出 fleet 注册函数。
- Modify: `src/web/server.ts` — 实例化 registry/controller/LocalDeviceAdapter,注册路由,启动时检测 `fleet-node.json` 启动 agent。
- Modify: `src/web/middleware/auth.ts` — pair/node-WS 豁免。
- Modify: `src/web/sse-events.ts` + `src/web/public/constants.js` — 登记 `fleet:*` 事件。
- Create: `src/web/public/fleet-api.js` / `src/web/public/fleet-dashboard.js`;Modify: `index.html`、`app.js`、`styles.css`。
- Tests: `test/fleet/{protocol,device-registry,node-config,local-session-ops,device-adapter,central-controller,node-agent}.test.ts`、`test/routes/{fleet-routes,fleet-ws-routes}.test.ts`;可选 `scripts/fleet-dev-smoke.sh`。

---

### Task 1: 仓库引导(非空目录)与基线验证

**Files:**
- Repo root: `/Users/ming/Documents/code/ai/codeman`(已含 `codeman-central-dashboard-plan.md` 与 `docs/superpowers/specs/…`)

**Interfaces:**
- Produces: 可构建、测试通过的 `fleet-dashboard` 分支;spec 与 plan 已入库。

- [ ] **Step 1: fork 并把上游代码引导进非空目录**(`git clone` 对非空目录会失败,用 init+fetch)

```bash
gh repo fork Ark0N/Codeman --clone=false || true   # fork 已存在时忽略
cd /Users/ming/Documents/code/ai/codeman
git init
git remote add origin https://github.com/michael-ltm/Codeman.git
git remote add upstream https://github.com/Ark0N/Codeman.git
git fetch upstream master
git checkout -b fleet-dashboard upstream/master
```

预期:工作区出现上游代码;本地已有的 plan/spec 文件保持为未跟踪文件(上游无同名文件,无冲突)。

- [ ] **Step 2: 基线验证**

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test -- test/routes/ws-routes.test.ts
```

预期:全部通过。任何失败都先修基线再继续。

- [ ] **Step 3: 提交文档**

```bash
git add codeman-central-dashboard-plan.md docs/superpowers/
git commit -m "docs: add fleet dashboard spec and implementation plan"
```

### Task 2: 默认端口改 3100(共 3 处)

**Files:**
- Create: `src/config/server-defaults.ts`
- Modify: `src/cli.ts:580`(`--port` 默认值)
- Modify: `src/web/server.ts:292`(`WebServer` 构造器默认参数)
- Modify: `src/web/server.ts:2486`(`startWebServer` 默认参数)
- Test: `test/cli-commands.test.ts`(沿用现有 CLI 测试文件的既有模式追加断言)

**Interfaces:**
- Produces: `DEFAULT_CODEMAN_PORT: number`(= 3100),后续任务 import 自 `src/config/server-defaults.ts`。

- [ ] **Step 1: 写失败测试** — 在 `test/cli-commands.test.ts` 按该文件现有断言风格追加:

```ts
import { DEFAULT_CODEMAN_PORT } from '../src/config/server-defaults.js';

describe('default web port', () => {
  it('is 3100', () => {
    expect(DEFAULT_CODEMAN_PORT).toBe(3100);
  });
  it('cli --port option defaults to 3100', () => {
    // 按 cli-commands.test.ts 中现有的 option 断言模式,定位 web 命令的 port option:
    // expect(portOption.defaultValue).toBe(String(DEFAULT_CODEMAN_PORT))
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test -- test/cli-commands.test.ts`,预期 FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
// src/config/server-defaults.ts
export const DEFAULT_CODEMAN_PORT = 3100;
```

- `src/cli.ts:580`:`process.env.CODEMAN_PORT || '3000'` → `process.env.CODEMAN_PORT || String(DEFAULT_CODEMAN_PORT)`,顶部加 import。
- `src/web/server.ts:292` 与 `:2486`:两处 `port = 3000` → `port: number = DEFAULT_CODEMAN_PORT`,加 import。
- 全库 `grep -rn "3000" src/ | grep -v node_modules` 复查是否有第 4 处默认值(文档字符串除外)。

- [ ] **Step 4: 验证通过** — `npm run typecheck && npm test -- test/cli-commands.test.ts`,预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config/server-defaults.ts src/cli.ts src/web/server.ts test/cli-commands.test.ts
git commit -m "feat: default codeman web to port 3100"
```

### Task 3: Fleet 协议(类型 + zod + Tab 映射)

**Files:**
- Create: `src/fleet/protocol.ts`
- Test: `test/fleet/protocol.test.ts`

**Interfaces:**
- Produces(后续所有任务依赖,签名精确):

```ts
export const FLEET_PROTOCOL_VERSION = 1;
export type FleetDeviceStatus = 'online' | 'offline';
export type FleetSessionStatus = 'idle' | 'busy' | 'stopped' | 'error';
export type FleetSessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini'; // 与 src/types/session.ts:44 SessionMode 对齐
export interface FleetCapabilities { tmux: boolean; claude: boolean; codex: boolean; shell: boolean }
export interface FleetDeviceSummary { id; name; hostname; platform: string; arch; username; version; status: FleetDeviceStatus; lastSeenAt: number; activeSessionCount: number; capabilities: FleetCapabilities }
export interface FleetDeviceJoinInfo { /* = FleetDeviceSummary 去掉 id/status/lastSeenAt/activeSessionCount */ }
export interface FleetSessionSummary { deviceId; id; name?; mode: FleetSessionMode; status: FleetSessionStatus; workingDir: string; pid: number | null; createdAt: number; lastActivityAt: number }
export interface FleetSessionTab { key; deviceId; sessionId; deviceName; sessionLabel; title; mode; status; workingDir }
export interface CreateFleetSessionRequest { workingDir: string; mode?: FleetSessionMode; name?: string; prompt?: string }
export interface FleetDashboardState { devices: FleetDeviceSummary[]; sessions: FleetSessionSummary[]; sessionTabs: FleetSessionTab[]; generatedAt: number }

export type NodeToCentralFrame =
  | { t: 'hello'; protocol: 1; device: FleetDeviceSummary; sessions: FleetSessionSummary[] }
  | { t: 'heartbeat'; sessions: FleetSessionSummary[] }
  | { t: 'session:update'; session: FleetSessionSummary }
  | { t: 'terminal:data'; sessionId: string; data: string }
  | { t: 'terminal:clear'; sessionId: string }
  | { t: 'terminal:refresh'; sessionId: string }                 // 只发信号,缓冲走 get-buffer RPC
  | { t: 'ack'; requestId: string; data?: unknown }
  | { t: 'error'; requestId?: string; message: string };

export type CentralToNodeFrame =
  | { t: 'list-sessions'; requestId: string }
  | { t: 'create-session'; requestId: string; payload: CreateFleetSessionRequest }
  | { t: 'stop-session'; requestId: string; sessionId: string }
  | { t: 'get-buffer'; requestId: string; sessionId: string }
  | { t: 'terminal:subscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:unsubscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:input'; sessionId: string; data: string; seq?: number; cid?: string }
  | { t: 'terminal:resize'; sessionId: string; cols: number; rows: number; viewportType?: string; force?: boolean };

// zod schemas(每个类型一个,z.discriminatedUnion('t', …) 组装两个帧联合)
export const FleetDeviceJoinInfoSchema: z.ZodType<FleetDeviceJoinInfo>;
export const CreateFleetSessionRequestSchema: ...;
export const NodeToCentralFrameSchema: ...;
export const CentralToNodeFrameSchema: ...;
export function parseNodeToCentralFrame(raw: unknown): NodeToCentralFrame | null; // JSON.parse + safeParse,失败返回 null
export function parseCentralToNodeFrame(raw: unknown): CentralToNodeFrame | null;
export function buildFleetSessionTab(device: FleetDeviceSummary, session: FleetSessionSummary): FleetSessionTab;
```

- [ ] **Step 1: 写失败测试** `test/fleet/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FLEET_PROTOCOL_VERSION, NodeToCentralFrameSchema, CentralToNodeFrameSchema,
  parseNodeToCentralFrame, parseCentralToNodeFrame, buildFleetSessionTab,
} from '../../src/fleet/protocol.js';

const device = {
  id: 'dev_1', name: 'macmini', hostname: 'macmini.local', platform: 'darwin', arch: 'arm64',
  username: 'ming', version: '1.2.2', status: 'online' as const, lastSeenAt: 1, activeSessionCount: 1,
  capabilities: { tmux: true, claude: true, codex: true, shell: true },
};
const session = {
  deviceId: 'dev_1', id: 's1', name: 'codex', mode: 'codex' as const, status: 'busy' as const,
  workingDir: '/tmp/proj', pid: 123, createdAt: 1, lastActivityAt: 2,
};

describe('fleet protocol', () => {
  it('exports protocol version 1', () => expect(FLEET_PROTOCOL_VERSION).toBe(1));

  it('round-trips a valid hello frame', () => {
    const frame = { t: 'hello', protocol: 1, device, sessions: [session] };
    expect(parseNodeToCentralFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects unknown frame type and bad JSON', () => {
    expect(parseNodeToCentralFrame(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseNodeToCentralFrame('{oops')).toBeNull();
  });

  it('validates central frames incl. optional seq/cid input', () => {
    const input = { t: 'terminal:input', sessionId: 's1', data: 'ls\n', seq: 3, cid: 'b1' };
    expect(parseCentralToNodeFrame(JSON.stringify(input))).toEqual(input);
    expect(CentralToNodeFrameSchema.safeParse({ t: 'get-buffer', requestId: 'r1', sessionId: 's1' }).success).toBe(true);
    expect(CentralToNodeFrameSchema.safeParse({ t: 'create-session', requestId: 'r1', payload: {} }).success).toBe(false); // workingDir 必填
  });

  it('builds tab with key/device-name/label/title rules', () => {
    const tab = buildFleetSessionTab(device, session);
    expect(tab.key).toBe('dev_1:s1');
    expect(tab.title).toBe('macmini / codex');
    // 无 name 时回退 basename(workingDir),再回退 id 前 8 位
    const t2 = buildFleetSessionTab({ ...device, name: '' }, { ...session, name: undefined });
    expect(t2.deviceName).toBe('macmini.local');
    expect(t2.sessionLabel).toBe('proj');
    expect(t2.title).toBe('macmini.local / proj');
  });
});
```

- [ ] **Step 2: 确认失败** — `npm test -- test/fleet/protocol.test.ts`,预期 FAIL(模块不存在)。

- [ ] **Step 3: 实现 `src/fleet/protocol.ts`** — 按 Produces 签名完整实现。要点:

```ts
export function buildFleetSessionTab(device: FleetDeviceSummary, session: FleetSessionSummary): FleetSessionTab {
  const deviceName = device.name || device.hostname || device.id.slice(0, 8);
  const sessionLabel = session.name || basename(session.workingDir) || session.id.slice(0, 8);
  return {
    key: `${session.deviceId}:${session.id}`,
    deviceId: session.deviceId, sessionId: session.id,
    deviceName, sessionLabel, title: `${deviceName} / ${sessionLabel}`,
    mode: session.mode, status: session.status, workingDir: session.workingDir,
  };
}
```

`parse*Frame`:入参 string 则 `JSON.parse`(try/catch),对象直接 `safeParse`;失败一律 `null`。

- [ ] **Step 4: 验证通过** — `npm run typecheck && npm test -- test/fleet/protocol.test.ts`,预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/fleet/protocol.ts test/fleet/protocol.test.ts
git commit -m "feat: add fleet protocol types and schemas"
```

### Task 4: 设备注册表(配对码 + token 哈希)

**Files:**
- Create: `src/fleet/device-registry.ts`
- Test: `test/fleet/device-registry.test.ts`

**Interfaces:**
- Consumes: `FleetDeviceSummary`, `FleetDeviceJoinInfo`, `FleetCapabilities`(Task 3)。
- Produces:

```ts
export class DeviceRegistry {
  constructor(filePath?: string);                       // 默认 dataPath('fleet-devices.json')
  createPairingCode(now?: number): { code: string; expiresAt: number };
  consumePairingCode(code: string, device: FleetDeviceJoinInfo, now?: number): { deviceId: string; token: string };
  authenticate(deviceId: string, token: string): boolean;
  markOnline(deviceId: string, now?: number): void;     // 运行态,status 不持久化
  markOffline(deviceId: string, now?: number): void;
  getDevice(deviceId: string): FleetDeviceSummary | null;
  listDevices(now?: number): FleetDeviceSummary[];      // activeSessionCount 恒为 0,由 controller 覆盖
  saveNow(): void;
}
```

- [ ] **Step 1: 写失败测试** `test/fleet/device-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceRegistry } from '../../src/fleet/device-registry.js';

const joinInfo = {
  name: 'macbook', hostname: 'mb.local', platform: 'darwin', arch: 'arm64',
  username: 'ming', version: '1.2.2',
  capabilities: { tmux: true, claude: true, codex: false, shell: true },
};

describe('DeviceRegistry', () => {
  let file: string; let reg: DeviceRegistry;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'fleet-reg-')), 'fleet-devices.json');
    reg = new DeviceRegistry(file);
  });

  it('pairing code: 8 chars, no confusing chars, single-use, 10min expiry', () => {
    const { code, expiresAt } = reg.createPairingCode(1000);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(expiresAt).toBe(1000 + 10 * 60 * 1000);
    const { deviceId, token } = reg.consumePairingCode(code, joinInfo, 2000);
    expect(deviceId).toMatch(/^dev_/);
    expect(token.length).toBeGreaterThanOrEqual(43);            // 32 bytes base64url
    expect(() => reg.consumePairingCode(code, joinInfo, 3000)).toThrow(/invalid or expired/i); // 一次性
  });

  it('expired code fails', () => {
    const { code } = reg.createPairingCode(1000);
    expect(() => reg.consumePairingCode(code, joinInfo, 1000 + 10 * 60 * 1000 + 1)).toThrow(/invalid or expired/i);
  });

  it('authenticates correct token only; plaintext token never persisted', () => {
    const { code } = reg.createPairingCode(1000);
    const { deviceId, token } = reg.consumePairingCode(code, joinInfo, 2000);
    expect(reg.authenticate(deviceId, token)).toBe(true);
    expect(reg.authenticate(deviceId, token + 'x')).toBe(false);
    expect(reg.authenticate('dev_nope', token)).toBe(false);
    reg.saveNow();
    const raw = require('node:fs').readFileSync(file, 'utf8');
    expect(raw.includes(token)).toBe(false);                    // 只存 SHA-256
  });

  it('markOffline keeps device with offline status; reload from disk works', () => {
    const { code } = reg.createPairingCode(1000);
    const { deviceId } = reg.consumePairingCode(code, joinInfo, 2000);
    reg.markOnline(deviceId, 3000);
    expect(reg.getDevice(deviceId)?.status).toBe('online');
    reg.markOffline(deviceId, 4000);
    const d = reg.getDevice(deviceId)!;
    expect(d.status).toBe('offline');
    expect(d.lastSeenAt).toBe(4000);
    reg.saveNow();
    const reloaded = new DeviceRegistry(file);
    expect(reloaded.listDevices().map((x) => x.id)).toEqual([deviceId]);
    expect(reloaded.getDevice(deviceId)?.status).toBe('offline'); // 重启后一律 offline
  });
});
```

注:测试文件是 ESM,`require` 不可用——用 `import { readFileSync } from 'node:fs'` 并改写该行。

- [ ] **Step 2: 确认失败** — `npm test -- test/fleet/device-registry.test.ts`,预期 FAIL。

- [ ] **Step 3: 实现 `src/fleet/device-registry.ts`**:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import type { FleetDeviceJoinInfo, FleetDeviceSummary } from './protocol.js';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除 0 O 1 I
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface StoredDevice extends FleetDeviceJoinInfo { id: string; tokenHash: string; createdAt: number; lastSeenAt: number }
interface StoredFile { devices: Record<string, StoredDevice>; pairingCodes: Record<string, { expiresAt: number }> }

export class DeviceRegistry {
  private file: StoredFile = { devices: {}, pairingCodes: {} };
  private online = new Set<string>();
  constructor(private filePath: string = dataPath('fleet-devices.json')) {
    if (existsSync(filePath)) this.file = JSON.parse(readFileSync(filePath, 'utf8'));
  }
  createPairingCode(now = Date.now()) {
    const bytes = randomBytes(PAIRING_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
    const expiresAt = now + PAIRING_TTL_MS;
    this.file.pairingCodes[code] = { expiresAt };
    this.saveNow();
    return { code, expiresAt };
  }
  consumePairingCode(code: string, device: FleetDeviceJoinInfo, now = Date.now()) {
    const entry = this.file.pairingCodes[code];
    delete this.file.pairingCodes[code];                       // 无论成败都作废
    if (!entry || entry.expiresAt < now) { this.saveNow(); throw new Error('Pairing code invalid or expired'); }
    const deviceId = `dev_${randomBytes(6).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    this.file.devices[deviceId] = { ...device, id: deviceId, tokenHash: sha256(token), createdAt: now, lastSeenAt: now };
    this.saveNow();
    return { deviceId, token };
  }
  authenticate(deviceId: string, token: string): boolean {
    const d = this.file.devices[deviceId];
    return !!d && d.tokenHash === sha256(token);               // 哈希等长,直接比较即可
  }
  markOnline(deviceId: string, now = Date.now()) { this.online.add(deviceId); this.touch(deviceId, now); }
  markOffline(deviceId: string, now = Date.now()) { this.online.delete(deviceId); this.touch(deviceId, now); }
  getDevice(deviceId: string): FleetDeviceSummary | null {
    const d = this.file.devices[deviceId];
    return d ? this.toSummary(d) : null;
  }
  listDevices(): FleetDeviceSummary[] { return Object.values(this.file.devices).map((d) => this.toSummary(d)); }
  saveNow() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    renameSync(tmp, this.filePath);                            // 原子写
  }
  private touch(deviceId: string, now: number) {
    const d = this.file.devices[deviceId];
    if (d) { d.lastSeenAt = now; this.saveNow(); }
  }
  private toSummary(d: StoredDevice): FleetDeviceSummary {
    const { tokenHash: _t, createdAt: _c, ...rest } = d;
    return { ...rest, status: this.online.has(d.id) ? 'online' : 'offline', activeSessionCount: 0 };
  }
}
function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }
```

- [ ] **Step 4: 验证通过** — `npm run typecheck && npm test -- test/fleet/device-registry.test.ts`,预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/fleet/device-registry.ts test/fleet/device-registry.test.ts
git commit -m "feat: add fleet device registry with pairing codes"
```

### Task 5: 节点配置 + `codeman node join` CLI

**Files:**
- Create: `src/fleet/node-config.ts`
- Modify: `src/cli.ts`(新增 `node` 命令组;`node run` 在 Task 10 补全,本任务先注册 join)
- Test: `test/fleet/node-config.test.ts`
- Test: `test/cli-commands.test.ts`(追加 node 命令注册断言,按现有模式)

**Interfaces:**
- Consumes: `FleetDeviceJoinInfo`(Task 3)。
- Produces:

```ts
// src/fleet/node-config.ts
export interface FleetNodeConfig { centralUrl: string; deviceId: string; token: string; deviceName: string; joinedAt: number }
export function fleetNodeConfigPath(): string;                        // dataPath('fleet-node.json')
export function readFleetNodeConfig(filePath?: string): FleetNodeConfig | null;
export function writeFleetNodeConfig(config: FleetNodeConfig, filePath?: string): void;  // POSIX 下 chmod 0600
export function collectDeviceJoinInfo(name?: string): FleetDeviceJoinInfo;               // os.hostname/platform/arch/userInfo + package version + 能力探测
export async function joinFleet(centralUrl: string, code: string, name?: string, filePath?: string): Promise<FleetNodeConfig>;
```

- [ ] **Step 1: 写失败测试** `test/fleet/node-config.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetNodeConfig, writeFleetNodeConfig, joinFleet, collectDeviceJoinInfo } from '../../src/fleet/node-config.js';

const cfg = { centralUrl: 'http://100.93.252.18:3100', deviceId: 'dev_a', token: 'tok', deviceName: 'macbook', joinedAt: 1 };

describe('fleet node config', () => {
  afterEach(() => vi.restoreAllMocks());

  it('write/read round-trip with 0600 perms; missing file → null', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fleet-node-')), 'fleet-node.json');
    expect(readFleetNodeConfig(file)).toBeNull();
    writeFleetNodeConfig(cfg, file);
    expect(readFleetNodeConfig(file)).toEqual(cfg);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('collectDeviceJoinInfo fills host facts and capabilities', () => {
    const info = collectDeviceJoinInfo('macbook');
    expect(info.name).toBe('macbook');
    expect(info.platform).toBe(process.platform);
    expect(typeof info.capabilities.tmux).toBe('boolean');
  });

  it('joinFleet POSTs code+device, unwraps {success,data} envelope, writes config', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fleet-node-')), 'fleet-node.json');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://central:3100/api/fleet/pair');
      const body = JSON.parse(String(init.body));
      expect(body.code).toBe('ABCD2345');
      expect(body.device.name).toBe('macbook');
      return new Response(JSON.stringify({ success: true, data: { deviceId: 'dev_x', token: 'tok_y' } }), { status: 200 });
    }));
    const out = await joinFleet('http://central:3100', 'ABCD2345', 'macbook', file);
    expect(out.deviceId).toBe('dev_x');
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('tok_y');
  });

  it('joinFleet surfaces server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: 'Pairing code invalid or expired' }), { status: 400 })));
    await expect(joinFleet('http://central:3100', 'BAD', 'x', '/dev/null')).rejects.toThrow(/invalid or expired/i);
  });
});
```

- [ ] **Step 2: 确认失败** — `npm test -- test/fleet/node-config.test.ts`,预期 FAIL。

- [ ] **Step 3: 实现 `src/fleet/node-config.ts`** — 要点:

```ts
export function writeFleetNodeConfig(config: FleetNodeConfig, filePath = fleetNodeConfigPath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2));
  if (process.platform !== 'win32') chmodSync(filePath, 0o600);
}
export function collectDeviceJoinInfo(name?: string): FleetDeviceJoinInfo {
  // version 读 package.json(仿照 cli.ts 现有版本读取方式);
  // capabilities.tmux 用 TmuxManager.isTmuxAvailable()(src/tmux-manager.ts);
  // claude/codex 复用 POST /api/sessions 创建路径使用的 CLI 可用性检查(session-routes.ts:262 附近,
  //   定位其 import 的 resolver 并复用同一函数);shell 恒 true。
  return { name: name || hostname(), hostname: hostname(), platform: process.platform, arch: process.arch,
           username: userInfo().username, version: readPackageVersion(), capabilities: detectCapabilities() };
}
export async function joinFleet(centralUrl: string, code: string, name?: string, filePath?: string): Promise<FleetNodeConfig> {
  const device = collectDeviceJoinInfo(name);
  const res = await fetch(`${centralUrl.replace(/\/$/, '')}/api/fleet/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device }),
  });
  const body = await res.json();                                // 信封:{success,data|error}
  if (!res.ok || !body.success) throw new Error(body.error || `Pairing failed (HTTP ${res.status})`);
  const config: FleetNodeConfig = { centralUrl, deviceId: body.data.deviceId, token: body.data.token,
                                    deviceName: device.name, joinedAt: Date.now() };
  writeFleetNodeConfig(config, filePath);
  return config;
}
```

- [ ] **Step 4: CLI 注册** — `src/cli.ts` 按现有 commander 风格新增:

```ts
const node = program.command('node').description('Fleet node commands');
node.command('join <central-url>')
  .requiredOption('--code <pair-code>', 'one-time pairing code from central dashboard')
  .option('--name <device-name>', 'device display name (default: hostname)')
  .action(async (centralUrl, opts) => {
    const cfg = await joinFleet(centralUrl, opts.code, opts.name);
    console.log(`Joined fleet as ${cfg.deviceName} (${cfg.deviceId}).`);
    console.log('Restart `codeman web` (or run `codeman node run`) to come online.');
  });
node.command('run').description('Run web server bound to 127.0.0.1 with fleet agent')
  .action(async () => { /* Task 10 实现;本任务先留 console.error('not implemented yet') + process.exit(1) */ });
```

在 `test/cli-commands.test.ts` 按现有命令注册断言模式追加:`node join` 存在且 `--code` 为 required。

- [ ] **Step 5: 验证通过** — `npm run typecheck && npm test -- test/fleet/node-config.test.ts test/cli-commands.test.ts`,预期 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/fleet/node-config.ts src/cli.ts test/fleet/node-config.test.ts test/cli-commands.test.ts
git commit -m "feat: add fleet node pairing config and join command"
```

### Task 6: 抽取可复用的会话辅助函数(重构,不改行为)

**Files:**
- Modify: `src/web/route-helpers.ts`
- Modify: `src/web/routes/session-routes.ts`(创建/删除/读缓冲三个 handler 改为调用抽取后的函数)
- Test: 现有 `test/routes/session-routes.test.ts`(如存在)必须保持全绿——这是重构的验收

**背景:** fleet 的本地设备适配器与 node agent 都要"创建会话 / 停会话 / 读终端缓冲",这些逻辑目前内联在 route handler 里(创建:session-routes.ts:262-443;删除::476;读缓冲::983)。抽取成纯函数,REST 与 fleet 共用,避免复刻。

**Interfaces:**
- Produces(供 Task 7 消费,签名精确;`ctx` 类型沿用 session-routes 现有的 port 交集类型):

```ts
// src/web/route-helpers.ts 追加导出
export async function createSessionCore(ctx, input: { workingDir: string; mode?: SessionMode; name?: string }): Promise<Session>;
// 复用原 handler 全部逻辑:MAX_CONCURRENT_SESSIONS 上限、workingDir 存在且为目录校验、
// 按 mode 的 CLI 可用性检查、new Session({workingDir, mode, name, mux: ctx.mux, useMux: true, tmuxHistoryLimit})、
// addSession、persistSessionState、setupSessionListeners、broadcast SessionCreated,
// 以及 mode==='shell' ? startShell() : startInteractive()(fleet 会话总是交互式;原 handler 若把启动
// 放在单独端点,这里合并为"创建即启动",REST 路径行为不变——REST handler 只调用创建部分)。
export async function deleteSessionCore(ctx, sessionId: string, killMux?: boolean): Promise<void>;  // 默认 killMux=true
export async function readSessionTerminalBuffer(ctx, sessionId: string, tail?: number): Promise<string>;
// 与 GET /api/sessions/:id/terminal 相同重建:mux.captureActivePaneBuffer 前插 + Ink/alt-screen 清洗
```

**执行注意:** 抽取时逐段移动原 handler 代码,不重写;handler 变成"解析请求 → 调 core → 序列化响应"。若原代码中有仅 handler 需要的部分(如 HTTP 错误码映射),留在 handler。

- [ ] **Step 1:** 先跑基线:`npm test -- test/routes/`,记录全绿。
- [ ] **Step 2:** 抽取 `createSessionCore` / `deleteSessionCore` / `readSessionTerminalBuffer` 到 `route-helpers.ts`,session-routes.ts 三个 handler 改调用。
- [ ] **Step 3:** `npm run typecheck && npm run lint && npm test -- test/routes/`,预期与基线一致全绿。
- [ ] **Step 4: Commit**

```bash
git add src/web/route-helpers.ts src/web/routes/session-routes.ts
git commit -m "refactor: extract session core helpers for fleet reuse"
```

### Task 7: LocalSessionOps + FleetDeviceHandle + LocalDeviceAdapter

**Files:**
- Create: `src/fleet/local-session-ops.ts`
- Create: `src/fleet/device-adapter.ts`
- Test: `test/fleet/local-session-ops.test.ts`
- Test: `test/fleet/device-adapter.test.ts`

**Interfaces:**
- Consumes: Task 3 类型;Task 6 的 `createSessionCore`/`deleteSessionCore`/`readSessionTerminalBuffer`;`createMockRouteContext()`(test/mocks/mock-route-context.ts)与 mock session(test/mocks/mock-session.ts)。
- Produces:

```ts
// src/fleet/local-session-ops.ts —— fleet 侧唯一接触 Session/ctx 内部的模块
export type FleetTerminalEvent = { kind: 'data'; data: string } | { kind: 'clear' } | { kind: 'refresh' };
export type TerminalSink = (ev: FleetTerminalEvent) => void;
export interface LocalSessionOps {
  listSessions(): FleetSessionSummary[];
  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary>;
  stopSession(sessionId: string): Promise<void>;
  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void;   // shouldApplyInput 去重
  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void;
  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void;            // 返回退订
  getTerminalBuffer(sessionId: string): Promise<string>;
}
export function createLocalSessionOps(deviceId: string, ctx): LocalSessionOps;     // ctx = server 的 route context
export function sessionStatusForFleet(session: Session): FleetSessionStatus;

// src/fleet/device-adapter.ts
export interface FleetDeviceHandle {
  readonly deviceId: string;
  summary(): FleetDeviceSummary;
  listSessions(): Promise<FleetSessionSummary[]>;
  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary>;
  stopSession(sessionId: string): Promise<void>;
  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void;
  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void;
  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void;
  getTerminalBuffer(sessionId: string): Promise<string>;
}
export class LocalDeviceAdapter implements FleetDeviceHandle {
  constructor(identity: { deviceId: string; name: string; version: string; capabilities: FleetCapabilities }, ops: LocalSessionOps);
}
```

**实现要点(local-session-ops.ts):**

```ts
export function createLocalSessionOps(deviceId: string, ctx): LocalSessionOps {
  const toSummary = (s: Session): FleetSessionSummary => ({
    deviceId, id: s.id, name: s.name || undefined, mode: s.mode,
    status: sessionStatusForFleet(s), workingDir: s.workingDir,
    pid: s.pid ?? null, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt,
    // ↑ 字段名以 Session 实际属性为准:实现时打开 src/session.ts 的 toState()/toLightDetailedState()
    //   (session.ts:984/1048)核对 pid/createdAt/lastActivityAt 的真实属性名并映射。
  });
  return {
    listSessions: () => [...ctx.sessions.values()].map(toSummary),
    createSession: async (input) => {
      if (input.mode && input.mode !== 'shell' && input.mode !== 'claude' && input.mode !== 'codex'
          && input.mode !== 'opencode' && input.mode !== 'gemini') throw new Error(`Unknown mode ${input.mode}`);
      const session = await createSessionCore(ctx, { workingDir: input.workingDir, mode: input.mode ?? 'claude', name: input.name });
      return toSummary(session);
    },
    stopSession: (id) => deleteSessionCore(ctx, id, true),
    writeInput: (id, data, seq, cid) => {
      const s = getSessionOrThrow(ctx, id);
      if (cid != null && seq != null && !s.shouldApplyInput(cid, seq)) return;   // 至多一次
      s.write(data);
    },
    resize: (id, cols, rows, opts) => getSessionOrThrow(ctx, id).resize(cols, rows, opts),
    subscribeTerminal: (id, sink) => {
      const s = getSessionOrThrow(ctx, id);
      const onData = (d: string) => sink({ kind: 'data', data: d });
      const onClear = () => sink({ kind: 'clear' });
      const onRefresh = () => sink({ kind: 'refresh' });
      s.on('terminal', onData); s.on('clearTerminal', onClear); s.on('needsRefresh', onRefresh);
      return () => { s.off('terminal', onData); s.off('clearTerminal', onClear); s.off('needsRefresh', onRefresh); };
    },
    getTerminalBuffer: (id) => readSessionTerminalBuffer(ctx, id),
  };
}
function getSessionOrThrow(ctx, id: string): Session {
  const s = ctx.sessions.get(id);
  if (!s) throw new Error('Session not found');
  return s;
}
export function sessionStatusForFleet(session: Session): FleetSessionStatus {
  // 复用现有 UI 会话列表的状态字段(getLightSessionsState 输出中的 status/state 字段,server.ts:554 附近核对),
  // 显式 switch 映射到 'idle'|'busy'|'stopped'|'error';未知值落 'idle'。进程已退出 → 'stopped'。
}
```

**实现要点(device-adapter.ts):** `LocalDeviceAdapter` 是纯委托:`summary()` 返回 identity + `status:'online'` + `lastSeenAt: Date.now()` + `activeSessionCount = ops.listSessions().filter(s => s.status !== 'stopped').length`;`platform/arch/hostname/username` 取自 `os`;其余 8 个方法逐一转发 `ops`(`listSessions` 包 `Promise.resolve`)。

- [ ] **Step 1: 写失败测试** `test/fleet/local-session-ops.test.ts`(用 `createMockRouteContext()` + mock session):

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMockRouteContext } from '../mocks/mock-route-context.js';
import { createLocalSessionOps } from '../../src/fleet/local-session-ops.js';

describe('LocalSessionOps', () => {
  it('lists sessions as FleetSessionSummary with deviceId stamped', () => {
    const ctx = createMockRouteContext();                       // 含 _session(见 mock 实现)
    const ops = createLocalSessionOps('dev_local', ctx);
    const list = ops.listSessions();
    expect(list.every((s) => s.deviceId === 'dev_local')).toBe(true);
  });
  it('writeInput applies shouldApplyInput dedup', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;                                     // mock session
    s.shouldApplyInput = vi.fn(() => false);
    s.write = vi.fn();
    createLocalSessionOps('d', ctx).writeInput(s.id, 'x', 1, 'c1');
    expect(s.write).not.toHaveBeenCalled();
  });
  it('subscribeTerminal forwards terminal/clear/refresh and unsubscribes cleanly', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    const events: string[] = [];
    const unsub = createLocalSessionOps('d', ctx).subscribeTerminal(s.id, (ev) => events.push(ev.kind));
    s.emit('terminal', 'abc'); s.emit('clearTerminal'); s.emit('needsRefresh');
    expect(events).toEqual(['data', 'clear', 'refresh']);
    unsub();
    s.emit('terminal', 'zzz');
    expect(events.length).toBe(3);
  });
  it('unknown session id throws Session not found', () => {
    const ctx = createMockRouteContext();
    expect(() => createLocalSessionOps('d', ctx).writeInput('nope', 'x')).toThrow(/session not found/i);
  });
});
```

`test/fleet/device-adapter.test.ts`:mock 一个 `LocalSessionOps`(全 `vi.fn()`),断言 `LocalDeviceAdapter` 逐方法转发、`summary().status === 'online'`、`activeSessionCount` 过滤 `stopped`。

- [ ] **Step 2: 确认失败** — `npm test -- test/fleet/local-session-ops.test.ts test/fleet/device-adapter.test.ts`,预期 FAIL。
- [ ] **Step 3: 实现两个模块**(按上文要点;mock ctx 若缺少个别成员,按 mock-route-context.ts 现有风格补齐 mock,而不是绕过测试)。
- [ ] **Step 4: 验证通过** — `npm run typecheck && npm test -- test/fleet/`,预期 PASS。
- [ ] **Step 5: Commit**

```bash
git add src/fleet/local-session-ops.ts src/fleet/device-adapter.ts test/fleet/local-session-ops.test.ts test/fleet/device-adapter.test.ts
git commit -m "feat: add fleet device handle and local adapter"
```

### Task 8: FleetCentralController(RPC、订阅引用计数、状态缓存、SSE 事件)

**Files:**
- Modify: `package.json` — dependencies 增加 `"ws": "^8"`(`npm install ws`)
- Create: `src/fleet/central-controller.ts`
- Test: `test/fleet/central-controller.test.ts`

**Interfaces:**
- Consumes: Task 3 帧类型与 `buildFleetSessionTab`;Task 4 `DeviceRegistry`;Task 7 `FleetDeviceHandle`/`TerminalSink`。
- Produces:

```ts
export interface NodeSocketLike { send(data: string): void; close(code?: number, reason?: string): void; readonly bufferedAmount?: number }
export class FleetCentralController extends EventEmitter {
  constructor(registry: DeviceRegistry, opts?: { requestTimeoutMs?: number });     // 默认 10_000
  registerLocalDevice(handle: FleetDeviceHandle): void;
  connectNode(deviceId: string, socket: NodeSocketLike, hello: Extract<NodeToCentralFrame, { t: 'hello' }>): void;
  disconnectNode(deviceId: string): void;
  handleNodeFrame(deviceId: string, frame: NodeToCentralFrame): void;              // 路由层解析后调用
  isOnline(deviceId: string): boolean;
  getHandle(deviceId: string): FleetDeviceHandle | null;                           // 本地或远程,统一接口
  getDashboardState(): Promise<FleetDashboardState>;
  // EventEmitter 事件(server 接线转发到 ctx.broadcast):
  //   emit('broadcast', 'fleet:device-online',   FleetDeviceSummary)
  //   emit('broadcast', 'fleet:device-offline',  { deviceId })
  //   emit('broadcast', 'fleet:sessions-updated', { deviceId, sessions: FleetSessionSummary[] })
  //   emit('device-offline', deviceId)   // 供浏览器终端 WS 路由关闭 4009
}
```

**实现要点:**

```ts
// 内部 RemoteDeviceHandle implements FleetDeviceHandle(不导出):
//  - request(frame):自增 requestId(`rq_${n}`),存 pending Map{resolve,reject,timer};
//    ack → resolve(frame.data);error(带 requestId)→ reject(new Error(message));
//    超时 requestTimeoutMs → reject(new Error('Fleet node request timed out'))。
//  - listSessions() 直接返回缓存(hello/heartbeat/session:update 维护),不发 RPC;
//    createSession → request({t:'create-session',…});stopSession → request({t:'stop-session',…});
//    getTerminalBuffer → request({t:'get-buffer',…}) 期望 data 为 string。
//  - writeInput/resize:fire-and-forget send(不占 requestId)。
//  - subscribeTerminal(sessionId, sink):sinks = Map<sessionId, Set<TerminalSink>>;
//    首个 sink → request({t:'terminal:subscribe'});退订到 0 → request({t:'terminal:unsubscribe'})
//    (两个 RPC 的失败只 log 不抛,订阅状态以 sinks 集合为准)。
// handleNodeFrame 路由:
//  - heartbeat/session:update → 更新会话缓存 + registry.markOnline(lastSeen)
//    + emit('broadcast','fleet:sessions-updated',…)(session:update 时);heartbeat 与缓存有差异才 emit。
//  - terminal:data/clear/refresh → 对应 sessionId 的每个 sink 调用 {kind:'data'|'clear'|'refresh'}。
//  - ack/error → pending 匹配。
// connectNode:若同 deviceId 已有连接,先 close(4000,'replaced') 旧 socket;建 RemoteDeviceHandle,
//  存 hello.sessions 为缓存,registry.markOnline,emit('broadcast','fleet:device-online', summary)。
// disconnectNode:reject 该设备全部 pending('Device disconnected'),清空 sinks(不通知节点),
//  registry.markOffline,emit('broadcast','fleet:device-offline',{deviceId}),emit('device-offline', deviceId)。
// getDashboardState():
//  devices = 本地 handle.summary() + registry.listDevices()(远程,activeSessionCount 用会话缓存覆盖),
//  排序:online 优先 → 有活动会话优先 → lastSeenAt 降序;
//  sessions = 本地 await listSessions() + 各在线远程缓存;
//  sessionTabs = 在线设备的非 stopped 会话 map(buildFleetSessionTab);generatedAt = Date.now()。
```

- [ ] **Step 1: 写失败测试** `test/fleet/central-controller.test.ts`(socket 用 `{ send: vi.fn(), close: vi.fn() }` 假对象;本地设备用 Task 7 测试同款 mock handle):

```ts
// 覆盖(每条一个 it,均为纯内存测试,vi.useFakeTimers 控制超时):
// 1. connectNode 后 isOnline=true、getDashboardState 含该设备与 hello 会话、收到 broadcast fleet:device-online
// 2. createSession → socket.send 发出 create-session 帧;handleNodeFrame(ack{data:summary}) → promise resolve
// 3. error 帧 → reject(message);无 ack 推进 10s → reject 'Fleet node request timed out'
// 4. subscribeTerminal 引用计数:两个 sink → 只发一次 terminal:subscribe;
//    terminal:data 帧 → 两个 sink 都收到;退订一个不发 unsubscribe,退订第二个才发
// 5. disconnectNode → isOnline=false、pending 全部 reject、broadcast fleet:device-offline、emit device-offline
// 6. heartbeat 更新会话缓存;session:update 触发 fleet:sessions-updated
// 7. registerLocalDevice 后 getDashboardState 合并本地设备,activeSessionCount 来自 handle
// 8. 排序:offline 设备排在 online 之后
```

- [ ] **Step 2: 确认失败** — `npm test -- test/fleet/central-controller.test.ts`,预期 FAIL。
- [ ] **Step 3:** `npm install ws && npm install --save-dev @types/ws`(若 devDeps 已有 @types/ws 则跳过后者),实现 `central-controller.ts`(controller 本身只依赖 `NodeSocketLike`,不直接 import `ws`——保持可测)。
- [ ] **Step 4: 验证通过** — `npm run typecheck && npm test -- test/fleet/central-controller.test.ts`,预期 PASS。
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/fleet/central-controller.ts test/fleet/central-controller.test.ts
git commit -m "feat: add fleet central controller"
```

### Task 9: 节点 WS 端点(`/ws/fleet/node`)+ 认证豁免

**Files:**
- Create: `src/web/routes/fleet-ws-routes.ts`(本任务只做节点端点;浏览器终端端点在 Task 11)
- Modify: `src/web/middleware/auth.ts`(豁免 `POST /api/fleet/pair` 与 `GET /ws/fleet/node` 的 Basic Auth)
- Modify: `src/web/routes/index.ts`(导出 `registerFleetWsRoutes`)
- Test: `test/routes/fleet-ws-routes.test.ts`

**Interfaces:**
- Consumes: Task 4 `DeviceRegistry.authenticate`;Task 8 `FleetCentralController.connectNode/disconnectNode/handleNodeFrame`;Task 3 `parseNodeToCentralFrame`。
- Produces:

```ts
export function registerFleetWsRoutes(app: FastifyInstance, deps: {
  controller: FleetCentralController; registry: DeviceRegistry;
  getHostPolicy: () => { bindHost: string; allowedHosts: string[]; tunnelHost: string | null };
}): void;
```

**行为规格(节点端点):**

1. `GET /ws/fleet/node` `{websocket:true}`。认证:`req.headers.authorization` 必须为 `Bearer <token>`,`req.headers['x-codeman-device-id']` 必须存在,`registry.authenticate(deviceId, token)` 通过;否则 `socket.close(4001, 'Unauthorized')`。**不检查 Origin**(节点不是浏览器,没有 Origin;Host 检查保留)。
2. 认证通过后等待首帧,**5 秒内必须是合法 `hello`**(`parseNodeToCentralFrame` + `t==='hello'` + `protocol===FLEET_PROTOCOL_VERSION` + `hello.device.id === deviceId`),否则 `close(4002, 'Expected hello')`。
3. hello 合法 → `controller.connectNode(deviceId, socket, hello)`;此后每条消息 `parseNodeToCentralFrame`,合法帧交 `controller.handleNodeFrame(deviceId, frame)`,非法帧忽略并计数(连续 20 条非法 → `close(1003)`)。
4. `close` 事件 → `controller.disconnectNode(deviceId)`。
5. 心跳:沿用 ws-routes.ts 的 ping/pong 模式(30s ping,10s 无 pong terminate)。

**auth.ts 豁免:** 在 auth.ts:116-140 的 loopback/hook-secret 旁路附近,新增路径旁路:`POST /api/fleet/pair`(凭证=配对码,函数内加每 IP 每分钟 ≤10 次的速率限制,复用现有 `StaleExpirationMap` 模式)与 `GET /ws/fleet/node`(凭证=Bearer token,由路由层校验)。**其余 `/api/fleet/*` 与 `/ws/fleet/devices/*` 不豁免。**

- [ ] **Step 1: 写失败测试** — 照 `test/routes/ws-routes.test.ts:82-90` 模式:真实 Fastify + `@fastify/websocket`,监听 `127.0.0.1:3171`,client 用 `ws` 包,mock controller(`vi.fn()` 成员)+ 真 `DeviceRegistry`(临时文件,预先 pair 出 deviceId/token):

```ts
// 覆盖:
// 1. 无 Authorization → close 4001;错 token → 4001;伪 deviceId → 4001
// 2. 正确 Bearer + 首帧非 hello → close 4002
// 3. 正确 hello → controller.connectNode 被调用(deviceId、hello.sessions 透传)
// 4. hello 后发 heartbeat 帧 → controller.handleNodeFrame 收到解析后的帧
// 5. client 断开 → controller.disconnectNode 被调用
// 6. hello.device.id 与 header deviceId 不一致 → 4002
```

- [ ] **Step 2: 确认失败**,**Step 3: 实现**(fleet-ws-routes.ts + auth.ts 豁免 + routes/index.ts 导出),**Step 4:** `npm run typecheck && npm test -- test/routes/fleet-ws-routes.test.ts` PASS;另跑 `npm test -- test/routes/ws-routes.test.ts` 确认未破坏既有 WS。
- [ ] **Step 5: Commit**

```bash
git add src/web/routes/fleet-ws-routes.ts src/web/middleware/auth.ts src/web/routes/index.ts test/routes/fleet-ws-routes.test.ts
git commit -m "feat: add fleet node websocket endpoint"
```

### Task 10: FleetNodeAgent + `codeman node run` + 服务端接线

**Files:**
- Create: `src/fleet/node-agent.ts`
- Modify: `src/web/server.ts`(实例化 registry/controller/local adapter;启动时检测 `fleet-node.json` 启动 agent;controller 'broadcast' → ctx.broadcast)
- Modify: `src/cli.ts`(补全 `node run`)
- Test: `test/fleet/node-agent.test.ts`

**Interfaces:**
- Consumes: Task 5 `FleetNodeConfig`/`collectDeviceJoinInfo`;Task 7 `LocalSessionOps`;Task 3 帧类型;`ws` 包(`import WebSocket from 'ws'`)。
- Produces:

```ts
export class FleetNodeAgent {
  constructor(opts: {
    config: FleetNodeConfig; ops: LocalSessionOps; device: FleetDeviceSummary;   // status/lastSeenAt 由 agent 填
    wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;    // 测试注入
    heartbeatMs?: number;                                                        // 默认 10_000
  });
  start(): void;   // 连接 + 断线重连退避 1s,2s,4s…封顶 30s
  stop(): void;    // 停心跳、关连接、不再重连
}
export function startFleetNodeAgentIfConfigured(ctx, deviceInfoOverrides?): FleetNodeAgent | null;
// 读 fleet-node.json;无配置返回 null;有则 createLocalSessionOps(config.deviceId, ctx) + new FleetNodeAgent + start()
```

**实现要点:**

```ts
// 连接:new WebSocket(`${wsUrl(config.centralUrl)}/ws/fleet/node`,
//   { headers: { authorization: `Bearer ${config.token}`, 'x-codeman-device-id': config.deviceId } })
//   wsUrl:http→ws / https→wss。
// open → 发 hello{protocol:1, device, sessions: ops.listSessions()};启动 10s 心跳 heartbeat{sessions}。
// message → parseCentralToNodeFrame;处理:
//   list-sessions → ack{data: ops.listSessions()}
//   create-session → try{ ack{data: await ops.createSession(payload)} }catch(e){ error{requestId, message} }
//   stop-session / get-buffer 同模式(get-buffer 的 ack.data 为 string)
//   terminal:input → ops.writeInput(sessionId, data, seq, cid)(异常吞掉并 log,不回帧)
//   terminal:resize → ops.resize(...)
//   terminal:subscribe → subs.set(sessionId, ops.subscribeTerminal(sessionId, sink)) + ack;重复订阅幂等
//   terminal:unsubscribe → subs 退订 + ack
// sink → 终端批量:每 sessionId 一个 pending buffer,8ms flush(或 ≥16KB 立即);
//   背压:socket.bufferedAmount > 512*1024 时丢弃本批 data 并置 needRefresh[sessionId]=true,
//   bufferedAmount 回落(<64KB)后发一次 terminal:refresh{sessionId}。clear/refresh 事件直发不批。
// close → 清全部 subs 退订、停心跳、按退避 setTimeout 重连(stop() 后不再重连)。
```

- [ ] **Step 1: 写失败测试** `test/fleet/node-agent.test.ts` — 用 Task 9 同款真实 Fastify WS 服务器(端口 3172)扮演中央,收帧存数组;`ops` 全 mock:

```ts
// 覆盖:
// 1. start 后服务器 5s 内收到合法 hello(带 Bearer 头——服务器侧断言 req.headers)
// 2. 服务器发 create-session → agent 回 ack 且 data 为 ops.createSession 的返回
// 3. ops.createSession 抛错 → agent 回 error{requestId, message}
// 4. terminal:subscribe 后 mock sink 触发 data → 服务器收到 terminal:data
// 5. terminal:input 帧 → ops.writeInput 收到 (sessionId, data, seq, cid)
// 6. 服务器主动断开 → agent 在 ~1s 后重连(vi.useFakeTimers 或放宽 2s 真实等待)
// 7. stop() 后不再重连
```

- [ ] **Step 2: 确认失败**,**Step 3: 实现 node-agent.ts**。
- [ ] **Step 4: 服务端接线** — `src/web/server.ts`:

```ts
// 构造期(createRouteContext 附近):
//   this.deviceRegistry = new DeviceRegistry();
//   this.fleetController = new FleetCentralController(this.deviceRegistry);
//   this.fleetController.registerLocalDevice(new LocalDeviceAdapter(
//     { deviceId: 'local', name: os.hostname(), version: <package version>, capabilities: detectCapabilities() },
//     createLocalSessionOps('local', ctx)));
//   this.fleetController.on('broadcast', (event, data) => this.broadcast(event, data));
// setupRoutes()(server.ts:862-878 的注册序列里):
//   registerFleetWsRoutes(app, { controller, registry, getHostPolicy });   // Task 9 已建
//   registerFleetRoutes(app, { controller, registry });                    // Task 12 注册,此处先留接线位
// start() 末尾(listen 成功后):
//   this.fleetNodeAgent = startFleetNodeAgentIfConfigured(ctx);            // 有 fleet-node.json 才启动
// stop()/close 路径:this.fleetNodeAgent?.stop()
```

- [ ] **Step 5: 补全 `codeman node run`**(cli.ts):读 `readFleetNodeConfig()`,无配置则报错提示先 join;有则以 `host='127.0.0.1'`、端口 `DEFAULT_CODEMAN_PORT`(或 `CODEMAN_PORT`)调用 `startWebServer(...)`——agent 由 start() 内的检测自动启动。即"薄别名",无独立会话栈。
- [ ] **Step 6: 验证** — `npm run typecheck && npm run lint && npm test -- test/fleet/ test/routes/fleet-ws-routes.test.ts`,预期 PASS;`npm run build` 通过。
- [ ] **Step 7: Commit**

```bash
git add src/fleet/node-agent.ts src/web/server.ts src/cli.ts test/fleet/node-agent.test.ts
git commit -m "feat: add fleet node agent embedded in codeman web"
```

### Task 11: 浏览器远程终端 WS(`/ws/fleet/devices/:deviceId/sessions/:sessionId/terminal`)

**Files:**
- Modify: `src/web/routes/fleet-ws-routes.ts`
- Test: `test/routes/fleet-ws-routes.test.ts`(追加)

**Interfaces:**
- Consumes: Task 8 `controller.getHandle/isOnline` + `'device-offline'` 事件;Task 7 `TerminalSink`。
- Produces: 浏览器帧协议与本地终端(ws-routes.ts:19)**完全一致**:入 `{t:'i',d,seq,cid}` / `{t:'z',c,r,f,v}`;出 `{t:'o',d}` / `{t:'c'}` / `{t:'r'}` / `{t:'ia',seq}`。

**行为规格:**

1. 握手:`isAllowedRequestHost` + `isAllowedRequestOrigin`(与 ws-routes.ts:72-92 相同,浏览器端点**要**查 Origin)不通过 → `close(4003)`。
2. `controller.getHandle(deviceId)` 为 null 或设备 offline 或(远程)会话缓存无此 sessionId → `close(4004, 'Unknown device or session')`。
3. 连接数上限:每浏览器连接无会话级上限复用,但**同一 socket 授权前不订阅**;中央对单 IP 的 fleet 终端 WS 并发 >6 → `close(4008)`(模块级 Map 计数,照 ws-routes.ts:60 的 `MAX_WS_PER_SESSION` 模式)。
4. 通过后:`unsub = handle.subscribeTerminal(sessionId, sink)`,sink 翻译:`{kind:'data'}` → 按 ws-routes.ts:112 同款 8ms/16KB 批量 + DEC-2026 sync 包裹发 `{t:'o'}`;`clear` → `{t:'c'}`;`refresh` → `{t:'r'}`。
5. 收 `{t:'i'}`:`handle.writeInput(sessionId, d, seq, cid)`;`seq != null` 时回 `{t:'ia',seq}`(转发即 ACK,重复投递由节点端 `shouldApplyInput` 幂等吸收)。输入长度沿用 `MAX_INPUT_LENGTH`(src/config/terminal-limits.ts)。
6. 收 `{t:'z'}`:`handle.resize(sessionId, c, r, { viewportType: v, force: f })`,cols/rows 边界沿用 ws-routes 的 1–500 / 1–200。
7. `controller.on('device-offline', id)` 命中本连接 deviceId → `close(4009)`;浏览器 socket close → `unsub()` + 计数递减。
8. ping/pong 心跳同 ws-routes。

- [ ] **Step 1: 写失败测试**(追加到 `test/routes/fleet-ws-routes.test.ts`;mock controller 返回可控 handle:`subscribeTerminal` 记录 sink 供测试触发):

```ts
// 覆盖:
// 1. 未知设备 → close 4004;offline 设备 → 4004
// 2. sink 触发 data → client 收到 {t:'o'} 且 d 含原文(注意剥掉 DEC-2026 包裹再断言)
// 3. client 发 {t:'i',d,seq,cid} → handle.writeInput 收到四参;client 收到 {t:'ia',seq}
// 4. client 发 {t:'z',c:120,r:40,f:true,v:'desktop'} → handle.resize 收到映射后的参数
// 5. controller emit('device-offline', deviceId) → client close code 4009
// 6. client 断开 → subscribeTerminal 返回的 unsub 被调用
// 7. Origin 不合法 → 4003
```

- [ ] **Step 2: 确认失败**,**Step 3: 实现**,**Step 4:** `npm run typecheck && npm test -- test/routes/fleet-ws-routes.test.ts` PASS。
- [ ] **Step 5: Commit**

```bash
git add src/web/routes/fleet-ws-routes.ts test/routes/fleet-ws-routes.test.ts
git commit -m "feat: proxy remote terminal websockets through central"
```

### Task 12: Fleet REST 路由 + SSE 事件登记

**Files:**
- Create: `src/web/routes/fleet-routes.ts`
- Modify: `src/web/routes/index.ts`、`src/web/server.ts`(挂上 Task 10 预留的 `registerFleetRoutes` 接线位)
- Modify: `src/web/sse-events.ts` + `src/web/public/constants.js`(登记 `fleet:device-online` / `fleet:device-offline` / `fleet:sessions-updated`,两处必须镜像)
- Test: `test/routes/fleet-routes.test.ts`

**Interfaces:**
- Consumes: Task 8 controller;Task 4 registry;Task 3 schemas。
- Produces(REST 面,全部走 `{success,data}` 信封):

```
GET    /api/fleet                                   → FleetDashboardState
GET    /api/fleet/devices                           → { devices, sessions }(排序已在 controller 完成)
POST   /api/fleet/pairing-codes                     → { code, expiresAt, joinCommand }
POST   /api/fleet/pair                              → { deviceId, token }(豁免 Basic Auth,Task 9 已开)
POST   /api/fleet/devices/:deviceId/sessions        → FleetSessionSummary(设备离线 → 409 'Device is offline';RPC 超时 → 504)
DELETE /api/fleet/devices/:deviceId/sessions/:sessionId → { ok: true }
GET    /api/fleet/devices/:deviceId/sessions/:sessionId/terminal → { buffer: string }
```

**实现要点:**

```ts
// POST /api/fleet/pairing-codes:
//   const { code, expiresAt } = registry.createPairingCode();
//   const origin = `${req.protocol}://${req.headers.host}`;
//   return { code, expiresAt, joinCommand: `codeman node join ${origin} --code ${code}` };
// POST /api/fleet/pair:body 用 zod 校验 { code: string, device: FleetDeviceJoinInfoSchema };
//   consumePairingCode 抛错 → 400 + 错误消息。
// POST /:deviceId/sessions:body 用 CreateFleetSessionRequestSchema;
//   handle = controller.getHandle(deviceId);!handle || !controller.isOnline(deviceId) → 409 'Device is offline';
//   err.message === 'Fleet node request timed out' → 504;'tmux unavailable' 类 → 422 透传消息。
// GET terminal:handle.getTerminalBuffer;节点无缓冲能力时返回 { buffer: '' }(靠 WS 实时流补)。
```

- [ ] **Step 1: 写失败测试** `test/routes/fleet-routes.test.ts` — 用 `createRouteTestHarness()`(test/routes/_route-test-utils.ts:26)+ mock controller/registry:

```ts
// 覆盖:
// 1. GET /api/fleet 返回 controller.getDashboardState() 结果(信封内 data 断言)
// 2. POST /api/fleet/pairing-codes → code 格式 + joinCommand 含请求 host 与 code
// 3. POST /api/fleet/pair 合法 → {deviceId, token};非法 code → 400 携带 'invalid or expired'
// 4. POST sessions:离线 → 409 'Device is offline';在线 → 透传 handle.createSession 返回
// 5. handle.createSession 抛 'Fleet node request timed out' → 504
// 6. DELETE session → handle.stopSession 被调用
// 7. GET terminal → { buffer } 透传
// 8. body 校验失败(缺 workingDir)→ 400
```

- [ ] **Step 2: 确认失败**,**Step 3: 实现**(fleet-routes.ts + index.ts 导出 + server.ts 接线 + 两处 SSE 事件登记)。
- [ ] **Step 4:** `npm run typecheck && npm run lint && npm test -- test/routes/fleet-routes.test.ts` PASS;`npm run check:frontend-syntax` 通过(constants.js 改动)。
- [ ] **Step 5: Commit**

```bash
git add src/web/routes/fleet-routes.ts src/web/routes/index.ts src/web/server.ts src/web/sse-events.ts src/web/public/constants.js test/routes/fleet-routes.test.ts
git commit -m "feat: expose fleet dashboard REST API and SSE events"
```

### Task 13: 前端 9a — Dashboard 核心(设备/会话/全局 Tab/单终端聚焦/配对)

**Files:**
- Create: `src/web/public/fleet-api.js`
- Create: `src/web/public/fleet-dashboard.js`
- Modify: `src/web/public/index.html`(容器 + script 标签)
- Modify: `src/web/public/app.js`(init 钩子一行)
- Modify: `src/web/public/styles.css`(fleet 样式块)
- Test: `npm run check:frontend-syntax`、`npm test -- test/frontend-public-tooling.test.ts test/render-index-html.test.ts` + 手动浏览器烟测

**Interfaces:**
- Consumes: Task 12 REST + SSE 事件;Task 11 WS 端点;现有全局:`CodemanApp`(app.js:288)、`escapeHtml`(constants.js)、`_apiJson/_apiPost/_apiDelete`(api-client.js)、vendored `Terminal` + `FitAddon`(public/vendor)。
- Produces: `CodemanApp.prototype` 上的 fleet 方法(下列名字 Task 14 依赖):`initFleetDashboard()`、`showFleetDashboard()`、`refreshFleetState()`、`renderFleetDevices()`、`renderFleetTabs()`、`selectFleetTab(key)`、`openFleetTerminal(key, containerEl)`、`closeFleetTerminal(key)`、`_fleetState`(最近一次 `FleetDashboardState`)、`_fleetTerms`(`Map<key, {term, fit, ws, el}>`)。

**结构(两个文件均按 api-client.js 的 `Object.assign(CodemanApp.prototype, {...})` 混入模式):**

```js
// fleet-api.js
Object.assign(CodemanApp.prototype, {
  async listFleet() { return this._apiJson('/api/fleet'); },
  async fleetCreatePairingCode() { return this._apiPost('/api/fleet/pairing-codes', {}); },
  async fleetCreateSession(deviceId, payload) { return this._apiPost(`/api/fleet/devices/${deviceId}/sessions`, payload); },
  async fleetStopSession(deviceId, sessionId) { return this._apiDelete(`/api/fleet/devices/${deviceId}/sessions/${sessionId}`); },
  async fleetTerminalBuffer(deviceId, sessionId) { return this._apiJson(`/api/fleet/devices/${deviceId}/sessions/${sessionId}/terminal`); },
});
```

```js
// fleet-dashboard.js 骨架(实现时保持函数级完整,禁止 TODO 占位)
Object.assign(CodemanApp.prototype, {
  async initFleetDashboard() {
    this._fleetTerms = new Map();
    this._fleetState = null;
    this._fleetSelectedKey = null;
    this._fleetShowHistory = false;
    try { this._fleetState = await this.listFleet(); } catch { return; }
    // SSE:在 app.js 现有 SSE 分发处登记(见 Step 3),三个 fleet:* 事件都只做 refreshFleetState()
    // 中央永远自带 local 设备,首屏判定只看"远程设备是否存在",否则 dashboard 会无条件抢占首屏
    const hasRemote = this._fleetState.devices.some((d) => d.id !== 'local');
    if (hasRemote || window.__CODEMAN_FLEET_DASHBOARD__) this.showFleetDashboard();
  },
  showFleetDashboard() { /* 显示 #fleet-dashboard、隐藏本地会话视图根节点;渲染三区 */ },
  hideFleetDashboard() { /* 反向;两个方向都保持本地视图完好(验收项) */ },
  async refreshFleetState() { this._fleetState = await this.listFleet(); this.renderFleetDevices(); this.renderFleetTabs(); },
  renderFleetDevices() { /* 设备卡:状态灯/platform/hostname/活动会话数;offline 卡置灰禁操作;
                            点击 → 更新 this._fleetSelectedDeviceId + 会话表(默认隐藏 stopped,
                            "显示历史"开关翻转 _fleetShowHistory);capabilities.tmux===false 显示能力错误标签 */ },
  renderFleetTabs() { /* 全局 Tab 条:_fleetState.sessionTabs,每个 tab.title = `设备名 / 原标签`
                         + status 点 + mode 徽标;点击 → selectFleetTab(tab.key);
                         关闭按钮只从本地可见集合移除(不 stop 会话) */ },
  selectFleetTab(key) { this._fleetSelectedKey = key; this.openFleetTerminal(key, document.getElementById('fleet-term-main')); },
  async openFleetTerminal(key, containerEl) {
    if (this._fleetTerms.has(key)) { /* 复用实例,搬运 DOM 到 containerEl,return */ }
    const [deviceId, sessionId] = key.split(/:(.+)/);          // sessionId 可能含':'
    const term = new Terminal({ scrollback: 5000 });           // 渲染器:9a 用默认(canvas)
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
    term.open(containerEl); fit.fit();
    const { buffer } = await this.fleetTerminalBuffer(deviceId, sessionId);
    if (buffer) term.write(buffer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/fleet/devices/${deviceId}/sessions/${sessionId}/terminal`);
    let seq = 0; const cid = `fleet-${Math.random().toString(36).slice(2, 10)}`;
    ws.onopen = () => this._fleetSendResize(key);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.t === 'o') term.write(m.d);
      else if (m.t === 'c') term.clear();
      else if (m.t === 'r') this._fleetRefreshBuffer(key); };   // 重拉 buffer 并 term.reset()+write
    ws.onclose = (ev) => { if (ev.code === 4009) this._fleetMarkTileOffline(key); };
    term.onData((d) => { seq += 1; ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d, seq, cid })); });
    // resize:ResizeObserver(containerEl) → fit.fit() → ws.send({t:'z',c:term.cols,r:term.rows,v:'desktop'})
    this._fleetTerms.set(key, { term, fit, ws, el: containerEl });
  },
  closeFleetTerminal(key) { /* ws.close() + term.dispose() + Map 删除 */ },
  async openFleetPairingDrawer() { /* fleetCreatePairingCode → 显示 code/过期倒计时/joinCommand + 复制按钮 */ },
  // 会话创建表单:设备下拉(默认当前选中,offline 禁选)、workingDir 必填文本框、
  //   mode 分段控件(claude/codex/shell/gemini/opencode)→ fleetCreateSession → refreshFleetState
});
```

**index.html:** 在现有 script 序列(index.html:2046-2067)`api-client.js` 之后插入 `fleet-api.js`、`fleet-dashboard.js`(同样 `defer` + 服务端 `?v=` 缓存戳模式);在主内容区加:

```html
<div id="fleet-dashboard" class="fleet-dashboard hidden">
  <header class="fleet-topbar">
    <div id="fleet-tabs" class="fleet-tabs"></div>
    <div class="fleet-topbar-actions">
      <button id="fleet-new-session-btn">新建会话</button>
      <button id="fleet-pair-btn">添加设备</button>
      <button id="fleet-back-local-btn">本地视图</button>
    </div>
  </header>
  <div class="fleet-body">
    <aside id="fleet-devices" class="fleet-devices"></aside>
    <main class="fleet-main">
      <div id="fleet-sessions" class="fleet-sessions"></div>
      <div id="fleet-term-area" class="fleet-term-area" data-layout="1">
        <div class="fleet-tile" id="fleet-term-main"></div>
      </div>
    </main>
  </div>
  <div id="fleet-pair-drawer" class="fleet-drawer hidden"></div>
  <div id="fleet-empty" class="fleet-empty hidden">
    <p>No devices joined</p><button id="fleet-empty-pair-btn">生成配对码</button>
  </div>
</div>
```

**app.js:** 在 `CodemanApp` init 流程(SSE 建连之后)加一行 `this.initFleetDashboard();`;在 SSE 消息分发处(app.js 内 `SSE_EVENTS` 相关 switch/映射,按现有模式)登记三个 `fleet:*` 事件 → `this.refreshFleetState()`。

**两个实现前必查项:**
1. **信封解包**:打开 api-client.js 确认 `_apiJson/_apiPost` 是否已解开 `{success,data}` 信封;若返回原始信封,则 fleet-api.js 内每个方法自行 `.data` 解包——`listFleet()` 的返回必须直接是 `FleetDashboardState`。
2. **`window.__CODEMAN_FLEET_DASHBOARD__` 注入**:照 `window.__CODEMAN_SOLO__` 的现成注入模式(server.ts 的 index.html 路由),在 `CODEMAN_FLEET_DASHBOARD=1` 环境变量存在时注入该 flag。
3. **渲染器**:网格格子一律 canvas;仅单格布局(`data-layout="1"`)时可选加载 `WebglAddon`(与 spec §6.2 一致)。

**styles.css(追加,遵守约束:密集操作风、圆角 ≤8px、无 hero、非单调紫蓝):**

```css
.fleet-dashboard{display:flex;flex-direction:column;height:100%}
.fleet-dashboard.hidden,.fleet-drawer.hidden,.fleet-empty.hidden{display:none}
.fleet-topbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border,#333)}
.fleet-tabs{display:flex;gap:4px;overflow-x:auto;flex:1;min-width:0}
.fleet-tab{display:flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;font-size:12px}
.fleet-tab.active{outline:1px solid var(--accent,#3a86)}
.fleet-tab .dot{width:7px;height:7px;border-radius:50%}
.fleet-tab .dot.busy{background:#e0a836}.fleet-tab .dot.idle{background:#43a86b}.fleet-tab .dot.error{background:#d4553f}
.fleet-body{display:flex;flex:1;min-height:0}
.fleet-devices{width:220px;overflow-y:auto;border-right:1px solid var(--border,#333);padding:8px}
.fleet-device-card{border:1px solid var(--border,#333);border-radius:8px;padding:8px;margin-bottom:8px;cursor:pointer;font-size:12px}
.fleet-device-card.offline{opacity:.45}
.fleet-device-card.selected{border-color:var(--accent,#3a86)}
.fleet-main{flex:1;display:flex;flex-direction:column;min-width:0}
.fleet-sessions{max-height:180px;overflow-y:auto;padding:8px;font-size:12px}
.fleet-term-area{flex:1;display:grid;gap:4px;padding:4px;min-height:0}
.fleet-term-area[data-layout="1"]{grid-template-columns:1fr}
.fleet-term-area[data-layout="2"]{grid-template-columns:1fr 1fr}
.fleet-term-area[data-layout="4"]{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.fleet-tile{position:relative;min-height:0;border:1px solid var(--border,#333);border-radius:6px;overflow:hidden}
.fleet-tile.focused{border-color:var(--accent,#3a86)}
.fleet-tile .tile-offline{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font-size:13px}
@media (max-width:768px){.fleet-devices{width:140px}.fleet-term-area[data-layout="2"],.fleet-term-area[data-layout="4"]{grid-template-columns:1fr;grid-template-rows:none}}
```

- [ ] **Step 1:** 建 `fleet-api.js` + `fleet-dashboard.js`(按骨架补完整实现,无占位),改 index.html/app.js/styles.css。
- [ ] **Step 2:** `npm run check:frontend-syntax && npm run check:public-assets && npm run format:check`(不符则 `npm run format`)。
- [ ] **Step 3:** `npm test -- test/frontend-public-tooling.test.ts test/render-index-html.test.ts test/terminal-layout-css.test.ts`,预期 PASS。
- [ ] **Step 4: 手动烟测**(此时还没有远程设备,验证本地设备路径):

```bash
CODEMAN_PORT=3100 CODEMAN_HOST=127.0.0.1 npm run dev
```

打开 `http://127.0.0.1:3100`:因中央自带 local 设备,dashboard 应显示 1 台在线设备;创建 shell 会话 → Tab 出现 `<hostname> / <目录名>` → 终端可输入输出;配对抽屉能生成码;"本地视图"按钮能切回原 UI 且原 UI 正常。

- [ ] **Step 5: Commit**

```bash
git add src/web/public/fleet-api.js src/web/public/fleet-dashboard.js src/web/public/index.html src/web/public/app.js src/web/public/styles.css
git commit -m "feat: add fleet dashboard UI core"
```

### Task 14: 前端 9b — 分屏网格(MVP)

**Files:**
- Modify: `src/web/public/fleet-dashboard.js`
- Modify: `src/web/public/styles.css`(如需微调,布局 CSS 已在 Task 13 就位)
- Test: 同 Task 13 的语法/资产检查 + 手动烟测

**Interfaces:**
- Consumes: Task 13 的 `openFleetTerminal(key, containerEl)`/`closeFleetTerminal(key)`/`_fleetTerms`。
- Produces: `setFleetLayout(n /*1|2|4*/)`、`pinFleetTab(key)`、`unpinFleetTile(index)`、`_fleetLayout`、`_fleetPinned: (key|null)[]`。

**行为规格:**

1. 布局切换控件(1/2/2×2)置于 `fleet-term-area` 上方工具条;切换即改 `data-layout` 并重排 tile div(`fleet-tile-0..3`)。
2. `_fleetPinned` 数组长度 = 布局格数;Tab 右键/长按或 tab 上的 pin 按钮 → `pinFleetTab(key)` 填入第一个空格(满了替换最旧);每格顶部显示 `tab.title` 小条 + 关闭按钮。
3. 每格独立调用 `openFleetTerminal(key, tileEl)`——**输入按格路由由 per-tile WS 结构保证**;点击格子设 `.focused`(仅视觉,键盘焦点由 xterm 自身管理)。
4. 同一会话被钉两格:第二格复用会提示"已在分屏中"并聚焦既有格(一个 key 一个实例,避免同会话双 WS)。
5. 布局缩小(4→1)时多余格 `closeFleetTerminal`;`ResizeObserver` 驱动各格 `fit.fit()` + 发 `{t:'z',…,v:'desktop'}`(节点侧由现有 `claimDesktopSizing` 90s 仲裁,无新机制)。
6. 上限:同屏 ≤4 格(布局本身限制);`_fleetTerms.size > 6` 时最久未用且未钉的实例被 `closeFleetTerminal`(对应中央的单浏览器 ≤6 并发约束)。
7. 掉线:4009 关闭的格显示 `.tile-offline` 遮罩("设备已离线"),设备重新上线(SSE fleet:device-online)且格仍被钉 → 自动重连重开。

- [ ] **Step 1:** 实现上述 7 条(完整代码,禁止占位)。
- [ ] **Step 2:** `npm run check:frontend-syntax && npm run check:public-assets`。
- [ ] **Step 3: 手动烟测:** 本地设备开 2 个 shell 会话,布局切 2 格,各钉一个:两格同时滚动输出;在 A 格输入不影响 B 格;切回 1 格布局,B 的 WS 被关闭(DevTools Network 验证);再切回 2 格自动恢复。
- [ ] **Step 4: Commit**

```bash
git add src/web/public/fleet-dashboard.js src/web/public/styles.css
git commit -m "feat: add fleet split-grid terminals"
```

### Task 15: 端到端本机双进程烟测

**Files:**
- Create: `scripts/fleet-dev-smoke.sh`
- Create: `docs/fleet-dashboard.md`(部署与手动烟测文档)

**Interfaces:**
- Consumes: 全部已完成任务;`CODEMAN_INSTANCE`(instance.ts:36,同时隔离数据目录与 tmux socket)。

- [ ] **Step 1: 写烟测脚本** `scripts/fleet-dev-smoke.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build

# 中央:instance=fleetc,端口 3100
CODEMAN_INSTANCE=fleetc CODEMAN_HOST=127.0.0.1 CODEMAN_PORT=3100 node dist/index.js web &
CENTRAL_PID=$!
trap 'kill $CENTRAL_PID $NODE_PID 2>/dev/null || true' EXIT
sleep 3
curl -fsS http://127.0.0.1:3100/api/fleet >/dev/null && echo "central ok"

# 生成配对码(信封解包用 python3/jq 均可)
CODE=$(curl -fsS -X POST http://127.0.0.1:3100/api/fleet/pairing-codes -H 'content-type: application/json' -d '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.code))')
echo "pairing code: $CODE"

# 节点:instance=fleetn(独立数据目录+tmux socket),join 后 node run
CODEMAN_INSTANCE=fleetn node dist/index.js node join http://127.0.0.1:3100 --code "$CODE" --name smoke-node
CODEMAN_INSTANCE=fleetn CODEMAN_PORT=3199 node dist/index.js node run &
NODE_PID=$!
sleep 5

# 断言:中央 fleet 状态包含 local + smoke-node 两台在线设备
curl -fsS http://127.0.0.1:3100/api/fleet | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const st=JSON.parse(s).data;
  const online=st.devices.filter(d=>d.status==="online");
  if(online.length<2){console.error("FAIL devices:",JSON.stringify(st.devices));process.exit(1)}
  console.log("fleet devices ok:",online.map(d=>d.name).join(", "))})'

# 远程创建 shell 会话 → 输入 echo → 校验缓冲
DEV=$(curl -fsS http://127.0.0.1:3100/api/fleet | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s).data;console.log(st.devices.find(d=>d.name==="smoke-node").id)})')
SID=$(curl -fsS -X POST "http://127.0.0.1:3100/api/fleet/devices/$DEV/sessions" -H 'content-type: application/json' -d "{\"workingDir\":\"$ROOT\",\"mode\":\"shell\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
sleep 2
# 输入走节点本地 REST(等价校验 mux 路径;终端 WS 交互由 Task 11 测试覆盖)
curl -fsS -X POST "http://127.0.0.1:3199/api/sessions/$SID/input" -H 'content-type: application/json' -d '{"input":"echo fleet-ok\n"}' >/dev/null
sleep 2
curl -fsS "http://127.0.0.1:3100/api/fleet/devices/$DEV/sessions/$SID/terminal" | grep -q 'fleet-ok' && echo "SMOKE PASS"
```

前提:本机有 tmux;两个 instance 互不污染 `~/.codeman`。若脚本环境不稳定,以单测为准并把手动步骤写进 `docs/fleet-dashboard.md`(允许,但要在文档标注)。

- [ ] **Step 2:** `chmod +x scripts/fleet-dev-smoke.sh && ./scripts/fleet-dev-smoke.sh`,预期末行 `SMOKE PASS`。
- [ ] **Step 3: 写 `docs/fleet-dashboard.md`**:架构一段(引 spec)、配对步骤、`codeman node join/run` 用法、烟测命令、故障排查(tmux 缺失/离线 409/配对码过期)。
- [ ] **Step 4: 全量回归** — `npm run build && npm run typecheck && npm run lint && npm test`,预期全绿。
- [ ] **Step 5: Commit**

```bash
git add scripts/fleet-dev-smoke.sh docs/fleet-dashboard.md
git commit -m "test: add fleet dashboard e2e smoke"
```

### Task 16: macmini 部署(手动清单,不提交任何密钥)

**Files:** 无代码变更;操作清单。

- [ ] 推分支:`git push -u origin fleet-dashboard`。
- [ ] macmini 上:

```bash
cd ~/.codeman/app
git remote set-url origin https://github.com/michael-ltm/Codeman.git
git fetch origin fleet-dashboard && git checkout fleet-dashboard
npm install && npm run build
```

- [ ] 以 `CODEMAN_HOST=0.0.0.0 CODEMAN_PORT=3100 CODEMAN_PASSWORD=<现有密码> codeman web` 启动(或更新现有 `com.codeman.web` LaunchAgent 指向新构建;密码只进环境/env 文件,不进 git)。
- [ ] 另一台 Tailscale 设备验证:

```bash
curl --noproxy '*' -u 'admin:<password>' http://100.93.252.18:3100/api/status
curl --noproxy '*' -u 'admin:<password>' http://100.93.252.18:3100/api/fleet
```

预期:`/api/fleet` 至少含 macmini 自己(local 设备,online)。

- [ ] 配对 macbook:dashboard 生成码 → `codeman node join http://100.93.252.18:3100 --code <code> --name macbook` → 本机重启 `codeman web`(或 `codeman node run`)→ dashboard 15 秒内出现 macbook online。
- [ ] `pc-e5`(Windows):tmux/WSL 就绪前照常配对,dashboard 应显示 `tmux` 能力缺失标签且禁用创建,而不是报错崩溃。
- [ ] 浏览器全流程验收(见验收清单)。

---

## Acceptance Checklist

- [ ] 访问一个固定 URL(如 `http://100.93.252.18:3100`)看到中央 dashboard,包含 macmini 自身(local 设备)。
- [ ] 所有已加入设备同页显示;上下线 15 秒内更新(SSE 实际秒级)。
- [ ] 顶层默认视图按设备突出活动会话;`stopped` 藏在"显示历史"后。
- [ ] 全局 Tab 跨设备,显示 `设备名 / 原标签`;两台设备同名会话产生两个独立 Tab,输入路由到正确 `{deviceId, sessionId}`。
- [ ] 点设备只更新页内状态,不跳转;点会话在同页打开终端;终端输入经中央到达远程节点。
- [ ] **分屏网格:布局 1/2/2×2 可切换,两格同时实时输出,输入互不串扰;掉线格显示离线遮罩,设备回线自动恢复。**
- [ ] 创建会话可指定设备/workingDir/mode;停止会话从中央生效;设备离线时创建返回 409。
- [ ] 配对码过期、一次性;节点重启免重配自动重连;中央重启后节点自动恢复 online。
- [ ] 设备本地 web UI 创建的会话,中央同样可见可控(嵌入式 agent 的核心收益)。
- [ ] ~~tmux 缺失设备显示能力错误,不能创建会话。~~ **【已知限制】** 服务器无 tmux 时**根本无法启动**(`createMultiplexer()` 在 `src/mux-factory.ts:17` 直接抛错 `tmux not found`,`codeman web` / `codeman node run` 拒绝启动),因此**在线**的 tmux-less 节点在设计上不可能存在——凡是 online 的设备必然自带可用 tmux。`capabilities.tmux===false` 的能力错误标签只对 **join 注册后从未上线(offline)** 的设备可达(能力信息来自配对时的静态探测)。完整行为见 `docs/fleet-dashboard.md` 的 Troubleshooting → "tmux missing"。
- [ ] `npm run build && npm run typecheck && npm run lint && npm test` 全绿。

## Security Notes

- 非 loopback 绑定必须设 `CODEMAN_PASSWORD`;fleet 浏览器面全部继承现有认证与 Host/Origin 守卫。
- 豁免仅两处且各有替代凭证:`POST /api/fleet/pair`(一次性配对码 + IP 速率限制)、`/ws/fleet/node`(Bearer token)。
- token 明文只在节点 `fleet-node.json`(0600);中央只存 SHA-256;token 不进 URL/日志。
- 无未认证发现端点;首版无远程文件浏览;不提交密钥/密码/运行态。

## Implementation Order

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10(此时命令行可见完整纵切:join + 上线 + RPC)→ 11 → 12 → 13(dashboard 可用)→ 14(分屏)→ 15 → 16。






