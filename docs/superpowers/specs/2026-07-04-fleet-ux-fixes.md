# Fleet UX 修复(2026-07-04 用户反馈)

用户确认的决策:
- Tab 模型:保持所有远程会话**自动混排**为 tab,但**关闭持久记住**(刷新不再出现);创建会话**自动打开**选中。
- 快捷启动:Run 按钮点击后**弹工作目录选择器**(复用 Rev4 的智能下拉 + 目录浏览模态)。
- 去掉"本机"表述,显示设备真名。

约束(硬):融入原设计([[ui-extend-not-replace]]);无原生对话框([[no-native-browser-dialogs]]);本地会话/tab 行为零回归;远端字符串 escapeHtml。

## #2 去"本机",显示设备真名
现状:fleet-panel.js:163 给 `id==='local'` 的设备加 `<span class="fleet-local-tag">本机</span>`;:404 下拉加 `(本机)`。
- 全部去掉"本机"标签,直接显示 `LocalDeviceAdapter.name`(= `os.hostname()`,如 `Elons-Mac-mini.local`)。
- 理由:从任意设备的浏览器访问,中央永远是同一台机(macmini),"本机"对远程访问者是误导——他在 macbook 上看到"本机"会以为是 macbook。
- 顶部欢迎屏设备标签行(session-ui.js 的 `renderWelcomeDeviceRow`)同样:local 设备显示真名,不显示"本机"。

## #4 关 tab 持久记住 + 重新打开途径
现状:`closeFleetTab`(fleet-tabs.js:216)把 key 加入内存 `_fleetHiddenTabKeys`;刷新后重置 → 所有在线远程会话又自动混排(:134 `refreshFleetState`)。
- **持久隐藏集**:关 tab 时把 `${deviceId}:${sessionId}` 写入 localStorage(`codeman:fleet-hidden-tabs`,per-device client-only,数组 JSON)。启动时读回 `_fleetHiddenTabKeys`。
- `refreshFleetState` 渲染 tab:跳过持久隐藏集里的 key。
- **清理**:每次 refresh,从隐藏集移除已不在 fleet sessions 的 key(会话已停止/消失)——防无限增长。
- **重新打开途径**:设备面板(fleet-panel)的会话行点击 → 打开该会话:从隐藏集移除该 key + `selectSession(key)` 出 tab 选中。给已关会话一个回来的入口。
- 本地会话的关闭行为零改动(红线)。

## #5 创建会话自动打开 + 出 tab
现状:`submitFleetCreateSession`(fleet-panel.js:605)创建后只 toast,不打开(注释明确 "Never touches selectSession")。
- 成功后:`selectSession(\`${deviceId}:${created.id}\`)` 自动打开终端 + 出 tab 选中(与本地创建一致体验)。
- 确保新 key 不在隐藏集(新 sessionId 不会复用旧 key,但保险起见 create 时从隐藏集移除该 key)。
- toast 保留但改为"已在 <设备名> 创建并打开"。

## #3 快捷启动工作目录选择器
现状:runClaude/runOpenCode/runGemini(session-ui.js:302/…)直接用 `quickStartCase`(默认 testcase),不选目录。
- 点 Run 后先弹**工作目录选择器**(复用 Rev4 的目录浏览模态 `openFleetDirBrowser` + 智能下拉 datalist 的机制,做成通用组件):列常用目录(现有会话目录 ∪ resume 候选目录)+ "浏览…"逐级选 + 手输,选定后启动。
- 本地选中设备:选定 dir → 现有本地 quick-start 流程,但用选定的 workingDir(接入现有 quick-start 的 workingDir 参数;若 quick-start 强绑 case,则退化为传 workingDir 覆盖)。本地快捷启动的其余行为尽量不变。
- 远程选中设备:选定 dir → `fleetCreateSession(deviceId, {mode, workingDir})` → 自动打开(同 #5)。
- 记住上次选择的目录,作为下拉默认(localStorage `codeman:last-workdir`,可选)。
- 无原生对话框;escapeHtml 目录名。
- 保留"取消"路径:选择器可关闭不启动。

## 任务
- Task A:#2 去本机 + #4 关 tab 持久 + 面板点会话打开 + #5 创建即打开(fleet-tabs.js / fleet-panel.js / 少量 session-ui.js)。
- Task B:#3 快捷启动工作目录选择器(通用目录选择组件 + 接入 Run 按钮本地/远程路径)。
- Task C:浏览器实测(去本机、关 tab 刷新不现、面板点会话打开、创建即打开出 tab、Run 弹目录选择)+ 门禁 + 部署 mini/macbook。
