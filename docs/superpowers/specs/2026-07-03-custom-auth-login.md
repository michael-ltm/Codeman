# Codeman 自定义登录页 + 密码管理设计

日期:2026-07-03
状态:已确认(用户拍板:密码 hash 存 ~/.codeman/auth.json;所有实例部署)
背景:当前用 HTTP Basic Auth,浏览器弹**原生登录框**,违反用户"不用原生 alert/confirm/prompt"的硬要求。改为融入 Codeman 风格的自定义登录页 + 支持改密码。

## 目标
1. 未登录时显示**融入 Codeman 原生风格**的自定义登录页(跟随 data-skin 主题),不弹浏览器原生框。
2. 登录后可在设置里**修改密码**,即时生效(不重启)。
3. 密码以 hash 持久化到 `~/.codeman/auth.json`;launchd 的 `CODEMAN_PASSWORD` 降级为初始默认值。
4. 不破坏 curl/hooks/节点连接等既有认证通道。

## 后端

### 密码存储 — `src/config/auth-store.ts`(新建,纯逻辑 + IO 分离)
- 文件 `dataPath('auth.json')`:`{ username, passwordHash, salt, algo: 'scrypt', updatedAt }`,写入权限 `0600`。
- **验证优先级**:`auth.json` 存在且完好 → 以它为准;否则 fallback 到 env `CODEMAN_USERNAME`(默认 admin)/`CODEMAN_PASSWORD`。
- `verifyCredentials(user, pass): boolean` — scrypt 派生比对,`crypto.timingSafeEqual`;用户名也 timing-safe 比。
- `setPassword(user, newPass): void` — 随机 16-byte salt,`scryptSync(pass, salt, 64)`,原子写 auth.json(tmp+rename,0600)。
- `isPasswordConfigured(): boolean` — auth.json 或 env 任一有密码。
- 损坏的 auth.json → try/catch fallback env(不锁死,仿 device-registry 约定)。

### `src/web/middleware/auth.ts` 改造
- 认证判定不变(有效 `codeman_session` cookie **或** 合法 Basic header **或** hook 旁路)。凭证比对改走 `auth-store.verifyCredentials`(而非直接读 env)。
- **移除 `WWW-Authenticate: Basic` 响应头**——这是触发浏览器原生框的根源。移除后:
  - 未认证的**页面导航请求**(非 `/api/*`、非静态资源的 GET,或 `Accept: text/html`)→ 返回**登录页 HTML**(200),内联自包含。
  - 未认证的 **`/api/*` 请求** → `401` JSON(`{success:false,error,errorCode:'UNAUTHORIZED'}`),前端据此显示登录态,不导航。
  - Basic header 仍被**接受验证**(curl `-u`、hooks 不受影响——curl 主动发 header,不依赖 WWW-Authenticate)。
- **新路由(认证豁免,复用 pair/hook 旁路的登记方式)**:
  - `POST /api/auth/login {username,password}` → `verifyCredentials` → 成功设 `codeman_session` cookie(复用现有 cookie 签发)+ `{success:true}`;失败走**现有 per-IP 限流**(10 次/IP → 429)。
  - `POST /api/auth/change-password {currentPassword,newPassword}` → **必须已认证** + `verifyCredentials(user,current)` 通过 → `setPassword` → `{success:true}`;新密码规则:长度 ≥ 8,非空。
  - `POST /api/auth/logout`(若现有 `/api/logout` 已清 cookie 则复用)。
- **空密码实例**(loopback 节点无 `CODEMAN_PASSWORD` 且无 auth.json)→ `isPasswordConfigured()` 为 false → 认证中间件早退(现状),**不启用登录页**。登录页只在有密码的实例(mini 中央)生效。

### 登录页 HTML
- 自包含单文件(内联 CSS/JS,不依赖需认证的资源),融入 Codeman 视觉:预读 `localStorage['codeman:skin']` 设 `data-skin`(仿 index.html 的防闪脚本);居中卡片、Logo、用户名 + 密码输入 + 登录按钮;**错误内联展示**(红字,非原生 alert)。
- 由 `renderLoginHtml()` 生成(`src/web/` 下),被 auth 中间件在未认证页面请求时返回。

## 前端(设置里改密码)
- App Settings 新增「账户 / Account」区:当前用户名(只读)+ 当前密码 + 新密码 + 确认新密码 + 保存按钮 → `POST /api/auth/change-password` → **应用自身 toast**(成功/失败),**无原生对话框**。
- 新旧密码不一致、长度不足等校验内联提示。
- 改密码成功后提示"下次登录用新密码";当前 session 不失效。

## 安全
- scrypt + 随机 salt;`timingSafeEqual` 比对;auth.json `0600`。
- 登录复用现有 per-IP 失败限流;change-password 必须已认证 + 验证当前密码。
- 移除 WWW-Authenticate 不降低安全(Basic header 仍验证);hook-secret 旁路、节点 WS Bearer、Host/Origin 守卫全部不变。
- 登录/改密码端点的 CSRF:沿用现有 Origin 守卫(state-changing 请求跨站拦截);登录端点允许无 Origin(curl)。
- 明文密码只在请求体瞬时存在,不落盘、不日志。

## 兼容性(回归红线)
- `curl -u admin:pass` 仍可(Basic 验证保留)。
- Claude Code hooks / status-telemetry 旁路不变。
- 节点出站 WS Bearer 认证不变;fleet 各端点认证不变。
- 现有 `codeman_session` cookie 机制复用,不改 cookie 格式。

## 任务拆分(SDD)
- **Task A**:`auth-store.ts`(hash 存储/验证/env fallback)+ 单测(验证优先级、timing-safe、损坏 fallback、0600、setPassword 往返)。
- **Task B**:auth.ts 改造(移除 WWW-Authenticate、未认证分流登录页 vs 401、login/change-password/logout 路由、限流复用)+ `renderLoginHtml` + 路由测试(curl -u 仍通、页面请求得登录页、API 得 401、login 成功设 cookie、change-password 需认证+验证旧、限流)。
- **Task C**:前端登录页 JS + 设置改密码 UI(融入风格、无原生对话框、内联校验)。
- **Task D**:浏览器实测(登录页显示/登录/错误提示/改密码/curl 兼容)+ 全量门禁 + 部署 mini+macbook。
