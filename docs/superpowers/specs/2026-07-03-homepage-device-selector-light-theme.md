# 主页设备选择器 + 浅色主题 + 全局视觉升级

日期:2026-07-03
状态:已确认(用户:顶部设备标签行 / 柔和浅灰白浅色主题 / 全局视觉升级)
约束(硬):**融入现有设计体系,不另起炉灶**([[ui-extend-not-replace]]);无浏览器原生对话框([[no-native-browser-dialogs]]);现有 skin(daylight-blue/green/og)与所有功能零回归。

## 现状(勘探已确认)
- 欢迎屏 `welcome-actions`(index.html:312):Run Claude/OpenCode/Gemini + Cloudflare Tunnel,经 session-ui.js 的 runClaude/runOpenCode/runGemini → `/api/quick-start` 在**中央本机**创建会话。
- Resume Conversation(historyTitle:374)已混排全设备(Rev 4,带设备 chip)。
- Skin 系统:`html[data-skin="…"]` CSS 变量块(styles.css:88 起),daylight-blue 默认,均为**深色系**。settings-ui.js `applyTheme` 设 `data-skin`。皮肤是 per-device 设置(不跨设备同步)。
- fleet 设备数据在 `this._fleetState.devices`(fleet-tabs.js);远程建会话 `fleetCreateSession(deviceId, payload)` 已存在。

## Task 1:浅色主题 skin(柔和浅灰白)
- **先审计** styles.css 的 skin 变量完整性:哪些表面走 CSS 变量、哪些硬编码深色。把浅色主题需要的核心表面(页面底/卡片/边框/文字/次要文字/输入框/按钮/hover/强调色/滚动条)收敛到变量(若已是变量则直接定义 light 值;硬编码处按需补变量或加 `[data-skin="light"]` 覆盖)。
- 新增 `html[data-skin="light"]` 全套变量:底 `#f5f6f8` 类柔和浅灰白、卡片 `#ffffff`/极浅、边框浅灰、主文字深灰 `#1f2328` 类、次要文字中灰、强调蓝(沿用现有蓝)、状态点绿/琥珀/红在浅底可读。
- 终端配色:light skin 下 xterm 用**浅色终端主题**(浅底深字);`applyTerminalSkin('light')` 加分支。
- 皮肤特定覆盖(welcome-btn-* 等,11132 起)补 light 版或用变量。
- 设置皮肤下拉加 "Light / 浅色" 选项(settings-ui.js + index.html 的皮肤 select)。
- 防闪:index.html 的预读脚本已按 `codeman:skin` 设 data-skin,light 自动生效。
- **验收**:切到 light 无深色残块(浏览器逐屏检查:欢迎屏/终端/设置/面板/登录页);切回 daylight-blue 逐字节如常。

## Task 2:主页设备选择器(顶部设备标签行)
- 欢迎屏标题下、快捷启动上方,新增**设备标签行**:每设备一个胶囊(状态点 + 名称 + 活动会话数;离线灰显),来自 `_fleetState.devices`;含"本机"(local)。默认选中本机。数据变化(SSE fleet:*)刷新。
- 选中态 `_welcomeDeviceId`(默认 'local'):
  - **快捷启动作用于选中设备**:runClaude/runOpenCode/runGemini 若选中远程设备 → 走 `fleetCreateSession(deviceId, {mode, workingDir, ...})`(workingDir 复用现有 quick-start 的目录选择;远程可复用 Rev 4 的目录选择器/智能下拉),否则走现有本地 `/api/quick-start`(本机路径零改动=红线)。按钮区加一行小字"→ 在 <设备名> 上创建"。
  - **Resume 列表按选中设备过滤**:标题变 "Resume Conversation (<设备名>)",列表只显示该设备候选(本机=本地历史;远程=该设备 resume-candidates)。选中"本机"时行为与今日一致(红线)。
- 离线设备:胶囊灰显,点击可选中但快捷启动禁用 + 提示"设备离线"。
- 只有一个设备(无远程节点)时:设备行可隐藏或只显示"本机",退化为今日体验(不强加 UI)。
- 全部远端字符串 escapeHtml;无原生对话框;用现有 CSS 变量(自动适配所有 skin 含 light)。

## Task 3:全局视觉升级(系统性打磨,不重排布局)
范围**具体化为可验证点**(避免"让它好看"的失控;不动 DOM 结构、不改交互):
- **设计令牌统一**:间距用一致尺度(4/8/12/16/24),圆角一致(卡片 ≤10px、按钮、输入),阴影层次(卡片轻阴影、悬浮态)——收敛到 CSS 变量,跨 skin 一致。
- **欢迎屏层次**:标题/设备行/快捷启动/搜索/Resume 的垂直节奏与间距梳理;快捷启动按钮组对齐与尺寸统一(现在 4 个按钮 2 行排布不齐——见截图);Resume 卡片 hover/圆角/内边距统一。
- **卡片/按钮一致性**:Resume 卡片、设备胶囊、快捷启动、搜索框风格统一(圆角/边框/hover)。
- **终端页/面板/设置**:轻度打磨(间距、卡片、滚动条一致),不重排。
- **红线**:所有改动纯 CSS(+ 必要的 class),不改 DOM 结构、不改任何 JS 行为;现有 skin 视觉不劣化(逐屏对比)。移动端不溢出。

## Task 4:整合浏览器实测 + 部署
- 桌面 + 移动视口,逐屏截图:欢迎屏(设备切换/快捷启动作用远程/Resume 过滤)、light↔daylight-blue 切换无残块、终端页、设置、登录页在 light 下。
- 回归红线:本机快捷启动/Resume、现有 skin、所有 fleet 功能不变。
- 全量门禁(typecheck/lint/frontend 检查/test:ci 排除既有 flaky)。
- 部署 mini + macbook。

## 任务边界与红线汇总
- 纯前端(Task 3 全 CSS);Task 2 触碰 runClaude/OpenCode/Gemini 与 Resume 渲染,**本机路径必须字节不变**。
- 融入现有 skin 变量体系,新增元素只用变量(自动适配 light + 现有 skin)。
- 无原生对话框;escapeHtml 远端字符串;移动端适配。
