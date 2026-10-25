# Codex 白昼 · Codex Daylight

把使用时间留在白天。一个 Windows 本地 Codex 额度监测与定时轻量激活工具。

[下载 Windows 预览版](https://github.com/nnnnompipo-glitch/codex-daylight/releases) · [版本记录](CHANGELOG.md) · [发布与校验](RELEASING.md)

Windows 原生小工具，用来按自定义时间发送一次轻量 Codex 请求，并查看服务端报告的五小时额度、其他共享额度和实际恢复时刻。使用现有 Codex CLI 的 ChatGPT 登录，无需 API Key。

## 使用

1. 下载 Releases 中的 Windows ZIP 并完整解压，双击 `启动Codex白昼.cmd` 或 `launch.cmd`。不要在 ZIP 内直接运行。
2. 等待“已连接 Codex”，检查剩余额度、恢复时间和最后同步时间。
3. 设置每日激活时间，例如 `08:00, 13:00, 18:00`，可用中文或英文逗号分隔。默认允许时段为 `07:00` 至 `23:00`，结束时间不包含在允许时段内，暂不支持跨夜时段。
4. 勾选“启用定时激活”，点击“保存设置”。首次运行默认暂停，最多配置 12 个不同时间。
5. 需要后台等待时点击“收起到托盘”或最小化；双击托盘图标可重新打开。关闭窗口或点击“退出工具”会停止后台。

仅在 Windows 已开机、用户已登录、工具保持运行且网络可用时执行。不自动开机、唤醒电脑或安装系统定时任务。重开工具会读取已保存的计划。休眠或关机错过超过 2 分钟的时段会跳过，不集中补发。

运行环境：Windows PowerShell 5.1，以及已使用 ChatGPT 账号登录的 Codex CLI。Windows 便携包自带 Node.js，不需要另装 Node；源码运行需要 Node.js 22 或更新版本，本机 Codex 随附的 Node.js 也可自动找到。若提示未登录，在终端运行 `codex login`。API Key 登录不能用于管理订阅五小时额度。

## 恢复时间如何确定

- 剩余额度和恢复时刻来自官方 `account/rateLimits/read`，并接收 `account/rateLimits/updated` 通知。以 `windowDurationMins = 300` 识别五小时窗口，不假定 primary 一定是五小时。
- 恢复时刻使用服务端 `resetsAt`，显示为本机时区；中国本机时区即北京时间。默认每 60 秒同步一次，可设置 30–600 秒，倒计时每秒更新。
- 断网显示最后同步的数据；恢复时刻已到但尚未取得新读数时，显示“等待服务端校准”，不自行把剩余额度改成 100%。
- 后续窗口的恢复时间在服务端给出前保持未知，不把“计划激活时间 + 5 小时”当作真实恢复时间。

**定时激活不能提前恢复或增加额度。** 官方文档没有保证一次消息必定重排五小时窗口；本工具只能按计划尝试使用，再同步实际结果。它有机会避免空闲时一直未开始使用，但不能保证每天多出几个窗口。其他应用与本机任务也会影响共享额度；周额度或其他限制仍然有效。

## 触发决策

到点 → 记录当日时段 → 查询额度 → 确认允许时段与计划仍有效 → 选择当前账号可用模型 → 再次查询额度 → 发送一条只要求回复 `OK` 的消息 → 同步实际恢复时间。

- 已在使用的五小时窗口（用量大于 0）会跳过，避免额外消耗。新鲜读数为 0 时可以尝试一次，恢复时间未知时也不作推算。
- 用量未知、连接失败、服务端明确到限、五小时或其他共享额度已满时跳过。
- 同一日期/时间先写本地执行记录，再做网络操作。失败或结果不明确时不会自动重发；相邻尝试至少间隔 15 分钟。
- 激活模型留空时使用账号模型列表中的默认模型；可填写确切的可用模型标识。不可用时提示错误，不自动换模型。
- 激活使用只读的临时 Codex 会话，工作目录是工具的数据目录下空的 `sandbox`；关闭命令执行、hooks、插件、应用、浏览器、电脑控制及多代理功能。模型请求在专用工作目录中运行，不使用你的项目作为工作目录。
- 不兑换额度重置奖励、不购买积分。仅查询额度和账号类型不会发送模型推理请求；点击“立即激活”或启用的定时触发会使用少量订阅额度。

## 本地数据与故障处理

配置、最近活动、执行记录和界面快照在 `%LOCALAPPDATA%\CodexCapacity\`。该目录不在本仓库中。不复制、读取或记录认证文件，登录和令牌刷新由 Codex CLI 自身处理；不保存邮件地址或账号标识。

计划默认暂停。如果本地执行记录丢失或损坏，而配置原本启用，工具会暂停计划，避免重复触发。检查界面提示后可重新保存并启用。程序退出后仍提示“正在运行”时，先确认任务栏和托盘中没有现有窗口；锁文件只在记录的进程已退出后自动恢复，不强行接管仍在运行的实例。

当前版本为 `0.1.0` 预览版。35 项应用测试及 4 项打包测试、Windows 原生界面和真实额度读取已验证；真实定时激活效果仍取决于服务端窗口规则，不能保证获得额外额度。旧原型的数据目录 `CodexCapacity` 保持兼容。

## 下载与校验

Releases 提供源码 ZIP、Windows x64 便携 ZIP、`SHA256SUMS.txt` 和构建清单。PowerShell 可用 `Get-FileHash -Algorithm SHA256 <ZIP路径>` 取得校验值，与 `SHA256SUMS.txt` 对照。

Node.js 运行时及第三方许可见便携包的 `runtime/LICENSE.txt` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Codex CLI 不包含在便携包内。

## 验证与开发

在本目录执行：

```powershell
node --test client.test.mjs core.test.mjs lifecycle.test.mjs worker.test.mjs scripts/release-core.test.mjs
node worker.mjs --check
```

前者使用临时目录与模拟客户端覆盖调度、重启去重、错误及退出边界；后者只读取真实额度，输出归一化结果，不发送模型请求。

原生界面冒烟截图，不连接 Codex：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File ui.ps1 -SmokeTest -ScreenshotPath "$env:TEMP\codex-capacity-ui.png"
```

真实连接界面截图：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File ui.ps1 -VerifyConnection -DataDirectory "$env:TEMP\codex-capacity-qa" -ScreenshotPath "$env:TEMP\codex-capacity-live.png"
```

连接验证在指定目录下创建全新的隔离数据目录，强制暂停计划，禁用激活操作，截图后自动退出后台。

官方依据：[App Server 接口](https://learn.chatgpt.com/docs/app-server)、[订阅额度说明](https://learn.chatgpt.com/docs/pricing)。
