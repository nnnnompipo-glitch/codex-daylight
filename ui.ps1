param(
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'CodexCapacity'),
    [switch]$SmokeTest,
    [switch]$VerifyConnection,
    [string]$ScreenshotPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:DataRoot = [System.IO.Path]::GetFullPath($DataDirectory)
$script:CommandsRoot = Join-Path $script:DataRoot 'commands'
$script:Worker = $null
$script:State = $null
$script:SettingsLoaded = $false
$script:LastStateText = ''
$script:LastCommandId = ''
$script:LastHistoryText = ''
$script:Exiting = $false
$script:Closing = $false
$script:WorkerExited = $false
$script:UiMutex = $null
$script:OwnsMutex = $false
$script:PendingCommandId = ''
$script:VerifyDeadline = $null
$script:VerificationResult = ''
$script:VerificationExitCode = 1

if ($VerifyConnection) {
    # Every verification gets a new directory, so enabled production settings or
    # queued activation commands can never be picked up by a read-only QA run.
    $script:DataRoot = Join-Path $script:DataRoot ('verify-' + [guid]::NewGuid().ToString('N'))
    $script:CommandsRoot = Join-Path $script:DataRoot 'commands'
}

function ConvertTo-ProcessArgument([string]$Argument) {
    # Arguments go straight to CreateProcess, never through a command shell.
    return '"' + [regex]::Replace($Argument, '(\\*)"', '$1$1\"').TrimEnd('\') +
        ('\' * ([regex]::Match($Argument, '\\+$').Length * 2)) + '"'
}

function Send-WorkerCommand([string]$Type, $Payload = $null) {
    $id = [guid]::NewGuid().ToString('N')
    $record = @{ id = $id; type = $Type; payload = $Payload }
    $json = $record | ConvertTo-Json -Depth 12 -Compress
    $temporary = Join-Path $script:CommandsRoot ($id + '.tmp')
    $destination = Join-Path $script:CommandsRoot ($id + '.json')
    [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::Move($temporary, $destination)
    $script:PendingCommandId = $id
    return $id
}

function New-TextLabel($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height,
    [float]$Size = 10, [string]$Color = '#27362F', [bool]$Bold = $false) {
    $control = New-Object System.Windows.Forms.Label
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, $Height)
    $style = [System.Drawing.FontStyle]::Regular
    if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
    $control.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $Size, $style)
    $control.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($Color)
    $Parent.Controls.Add($control)
    return $control
}

function New-ActionButton($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [bool]$Primary = $false) {
    $control = New-Object System.Windows.Forms.Button
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, 38)
    $control.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $control.FlatAppearance.BorderSize = 1
    $control.FlatAppearance.BorderColor = [System.Drawing.ColorTranslator]::FromHtml('#CAD7CF')
    $control.BackColor = [System.Drawing.Color]::White
    $control.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#234E3D')
    $control.Cursor = [System.Windows.Forms.Cursors]::Hand
    if ($Primary) {
        $control.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#245C46')
        $control.ForeColor = [System.Drawing.Color]::White
        $control.FlatAppearance.BorderColor = $control.BackColor
    }
    $Parent.Controls.Add($control)
    return $control
}

function New-TextInput($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width) {
    $control = New-Object System.Windows.Forms.TextBox
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, 30)
    $control.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $Parent.Controls.Add($control)
    return $control
}

function Show-ActionError([string]$Message) {
    $script:ActionStatus.Text = $Message
    $script:ActionStatus.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#A03E30')
}

function Invoke-UiCommand([string]$Type, $Payload = $null) {
    try {
        if ($VerifyConnection -and $Type -notin @('refresh', 'shutdown')) { throw '连接验证模式只读取额度，不允许保存计划或激活。' }
        if ($script:WorkerExited) { throw '后台已停止，请退出工具后重新启动。' }
        $null = Send-WorkerCommand $Type $Payload
        $script:ActionStatus.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#577064')
        $script:ActionStatus.Text = '已提交，等待后台处理…'
    }
    catch { Show-ActionError $_.Exception.Message }
}

function Format-LocalDate($Value, [string]$Format = 'MM-dd HH:mm:ss') {
    try { return ([DateTimeOffset]::Parse([string]$Value)).ToLocalTime().ToString($Format) }
    catch { return '—' }
}

function Format-ResetTime($Quota) {
    if ($null -eq $Quota -or $null -eq $Quota.resetsAt) { return '尚未取得' }
    try {
        return [DateTimeOffset]::FromUnixTimeSeconds([long]$Quota.resetsAt).ToLocalTime().ToString('MM-dd HH:mm:ss')
    }
    catch { return '尚未取得' }
}

function Format-Remaining($Quota) {
    if ($null -eq $Quota -or $null -eq $Quota.usedPercent) { return '—' }
    $remaining = [Math]::Max(0, [Math]::Min(100, (100 - [double]$Quota.usedPercent)))
    return ([Math]::Round($remaining, 1).ToString('0.#') + '%')
}

function Format-WindowLabel($Quota) {
    if ($null -eq $Quota -or $null -eq $Quota.windowDurationMins) { return '其他额度窗口' }
    $minutes = [double]$Quota.windowDurationMins
    if ($minutes -eq 10080) { return '周额度' }
    if ($minutes -eq 300) { return '五小时额度' }
    if ($minutes -ge 1440) { return (($minutes / 1440).ToString('0.#') + ' 天额度') }
    if ($minutes -ge 60) { return (($minutes / 60).ToString('0.#') + ' 小时额度') }
    return ($minutes.ToString('0.#') + ' 分钟额度')
}

function Load-SettingsIntoForm($Settings) {
    if ($null -eq $Settings) { return }
    $script:TimesInput.Text = @($Settings.times) -join ', '
    $script:StartInput.Text = [string]$Settings.activeStart
    $script:EndInput.Text = [string]$Settings.activeEnd
    $script:EnablePlan.Checked = [bool]$Settings.enabled
    $script:ModelInput.Text = [string]$Settings.model
    if ($null -ne $Settings.pollSeconds) {
        $script:PollInput.Value = [Math]::Max($script:PollInput.Minimum,
            [Math]::Min($script:PollInput.Maximum, [decimal]$Settings.pollSeconds))
    }
    $script:SettingsLoaded = $true
}

function Read-UiSettings {
    $times = @($script:TimesInput.Text -split '[,，;；\s]+' | Where-Object { $_ } | Sort-Object -Unique)
    $validTime = '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    if ($times.Count -eq 0 -or $times.Count -gt 12) { throw '请填写 1 至 12 个不同的激活时间，例如 08:00, 13:00, 18:00。' }
    foreach ($time in $times) {
        if ($time -notmatch $validTime) { throw ('时间格式不正确：' + $time + '。请使用两位小时和分钟，例如 08:00。') }
    }
    $start = $script:StartInput.Text.Trim()
    $end = $script:EndInput.Text.Trim()
    if ($start -notmatch $validTime -or $end -notmatch $validTime) { throw '允许激活时间段请使用 HH:mm 格式。' }
    if ($start -ge $end) { throw '允许激活时间段的结束时间必须晚于开始时间。' }
    foreach ($time in $times) {
        if ($time -lt $start -or $time -ge $end) { throw ('激活时间 ' + $time + ' 不在允许时间段内。') }
    }
    return @{
        enabled = $script:EnablePlan.Checked
        times = @($times | Sort-Object -Unique)
        activeStart = $start
        activeEnd = $end
        pollSeconds = [int]$script:PollInput.Value
        model = $script:ModelInput.Text.Trim()
    }
}

function Update-View {
    try {
        if ($script:Worker -and $script:Worker.HasExited -and -not $script:WorkerExited) {
            $script:WorkerExited = $true
            Show-ActionError '后台程序已停止，请退出工具后重新启动。'
        }
        $file = Join-Path $script:DataRoot 'state.json'
        if ([System.IO.File]::Exists($file)) {
            $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
            if ($raw -ne $script:LastStateText) {
                $candidate = $raw | ConvertFrom-Json
                # Ignore a previous instance's snapshot while the new worker starts.
                if ($script:Worker -and [int]$candidate.workerPid -eq $script:Worker.Id) {
                    $script:State = $candidate
                    $script:LastStateText = $raw
                    if (-not $script:SettingsLoaded) { Load-SettingsIntoForm $candidate.settings }
                }
            }
        }
        $state = $script:State
        if ($null -eq $state) {
            if ($script:WorkerExited) { $script:ConnectionLabel.Text = '后台已停止' }
            return
        }

        $fresh = $false
        try { $fresh = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$state.updatedAt)).TotalSeconds -lt 15 }
        catch {}
        $statusText = @{ starting = '正在连接 Codex'; ready = '已连接 Codex'; offline = '离线 · 等待重连'; error = '连接需要处理' }[[string]$state.connection]
        if (-not $statusText) { $statusText = '正在同步' }
        if (-not $fresh) { $statusText = '后台未响应 · 数据已过期' }
        if ($script:WorkerExited) { $statusText = '后台已停止' }
        if ($state.busy) { $statusText += ' · 正在处理' }
        $script:ConnectionLabel.Text = $statusText
        $script:MessageLabel.Text = [string]$state.message
        $script:ActivateButton.Enabled = (-not $VerifyConnection -and $fresh -and -not $script:WorkerExited -and -not $state.busy -and $state.connection -eq 'ready')
        $script:RefreshButton.Enabled = ($fresh -and -not $script:WorkerExited -and -not $state.busy)
        $script:SaveButton.Enabled = (-not $VerifyConnection -and -not $script:WorkerExited)
        $script:PauseButton.Enabled = (-not $VerifyConnection -and -not $script:WorkerExited)

        $quota = $state.quota
        $fiveHour = $null
        $other = $null
        if ($quota) {
            $fiveHour = $quota.fiveHour
            if (-not $fiveHour -and $quota.primary -and $quota.primary.windowDurationMins -eq 300) { $fiveHour = $quota.primary }
            if (-not $fiveHour -and $quota.secondary -and $quota.secondary.windowDurationMins -eq 300) { $fiveHour = $quota.secondary }
            if ($quota.secondary -and $quota.secondary.windowDurationMins -ne 300) { $other = $quota.secondary }
            elseif ($quota.primary -and $quota.primary.windowDurationMins -ne 300) { $other = $quota.primary }
        }
        $script:RemainingLabel.Text = Format-Remaining $fiveHour
        $script:ResetLabel.Text = Format-ResetTime $fiveHour
        $script:CountdownLabel.Text = '等待服务端同步'
        if ($fiveHour -and $null -ne $fiveHour.resetsAt) {
            $seconds = [long]$fiveHour.resetsAt - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            if ($seconds -le 0) { $script:CountdownLabel.Text = '恢复时间已到 · 等待服务端校准' }
            else {
                $span = [TimeSpan]::FromSeconds($seconds)
                $hours = [Math]::Floor($span.TotalHours)
                $script:CountdownLabel.Text = ('还有 {0:00}:{1:00}:{2:00}' -f $hours, $span.Minutes, $span.Seconds)
            }
        }
        $script:QuotaStatusLabel.Text = '服务端尚未返回五小时额度窗口'
        if ($fiveHour) { $script:QuotaStatusLabel.Text = '服务端返回的剩余额度' }
        if ($quota -and ($quota.stale -or -not $fresh -or $state.connection -ne 'ready')) {
            $script:QuotaStatusLabel.Text = '上次读数 · 当前连接未确认'
            $script:RemainingLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#8C785A')
        }
        else { $script:RemainingLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#245C46') }

        $script:OtherQuotaLabel.Text = '其他额度窗口：服务端尚未返回'
        if ($other) {
            $script:OtherQuotaLabel.Text = (Format-WindowLabel $other) + '剩余 ' + (Format-Remaining $other) +
                '    恢复：' + (Format-ResetTime $other)
        }
        $script:SyncedLabel.Text = '尚未同步额度'
        if ($quota -and $quota.fetchedAt) { $script:SyncedLabel.Text = '上次同步：' + (Format-LocalDate $quota.fetchedAt) }

        if ($state.settings.enabled -and $state.nextActivation) {
            $script:NextLabel.Text = Format-LocalDate $state.nextActivation.at 'MM-dd HH:mm'
            $script:PlanStatusLabel.Text = '计划已启用 · 电脑与工具需保持运行'
        }
        elseif ($state.settings.enabled) {
            $script:NextLabel.Text = '等待安排'
            $script:PlanStatusLabel.Text = '计划已启用 · 等待后台校准'
        }
        else {
            $script:NextLabel.Text = '计划已暂停'
            $script:PlanStatusLabel.Text = '设置时间后，勾选启用并保存'
        }

        if ($state.lastCommand -and $state.lastCommand.id -ne $script:LastCommandId) {
            $script:LastCommandId = [string]$state.lastCommand.id
            $script:ActionStatus.Text = [string]$state.lastCommand.message
            if ($state.lastCommand.ok) { $script:ActionStatus.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#245C46') }
            else { $script:ActionStatus.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#A03E30') }
        }

        $historyText = ''
        foreach ($entry in @($state.history)) {
            if ($null -eq $entry) { continue }
            $historyText += (Format-LocalDate $entry.at) + '  ' + [string]$entry.message + [Environment]::NewLine
        }
        if ($historyText -ne $script:LastHistoryText) {
            $script:HistoryBox.Text = $historyText
            $script:LastHistoryText = $historyText
        }
    }
    catch {
        # Atomic state updates can briefly race a read on Windows. Keep the last
        # snapshot; the heartbeat check clearly marks data stale if reads stop.
    }
}

function Save-FormScreenshot {
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
        $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bitmap.Dispose() }
}

function Test-VerificationComplete {
    if (-not $VerifyConnection -or $script:Closing) { return }
    $ready = $script:State -and $script:State.connection -eq 'ready'
    $failed = $script:WorkerExited -or ($script:State -and $script:State.connection -eq 'error')
    $timedOut = [DateTimeOffset]::UtcNow -ge $script:VerifyDeadline
    if (-not ($ready -or $failed -or $timedOut)) { return }
    $script:VerificationResult = 'timeout'
    if ($failed) { $script:VerificationResult = 'error' }
    if ($ready) { $script:VerificationResult = 'ready'; $script:VerificationExitCode = 0 }
    try { Save-FormScreenshot }
    catch {
        $script:VerificationResult = 'screenshot-error: ' + $_.Exception.Message
        $script:VerificationExitCode = 1
    }
    $form.Close()
}

try {
    if (($SmokeTest -or $VerifyConnection) -and
        (-not $ScreenshotPath -or -not [System.IO.Path]::IsPathRooted($ScreenshotPath))) {
        throw 'SmokeTest 或 VerifyConnection 需要通过 ScreenshotPath 提供绝对截图路径。'
    }
    if ($SmokeTest -and $VerifyConnection) { throw 'SmokeTest 与 VerifyConnection 不可同时使用。' }
    [System.IO.Directory]::CreateDirectory($script:DataRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($script:CommandsRoot) | Out-Null
    $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $hashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:DataRoot.ToLowerInvariant())) }
    finally { $hashAlgorithm.Dispose() }
    $mutexName = 'Local\CodexCapacityUi_' + [System.BitConverter]::ToString($hash).Replace('-', '').Substring(0, 24)
    $created = $false
    $script:UiMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
    $script:OwnsMutex = $created
    if (-not $created) {
        [System.Windows.Forms.MessageBox]::Show('额度管家已在运行。请在任务栏或右下角托盘打开现有窗口。', 'Codex 白昼') | Out-Null
        exit 0
    }

    $nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
    if (-not [System.IO.File]::Exists($nodePath)) {
        $nodePath = $null
        $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($node) { $nodePath = $node.Source }
    }
    if (-not $nodePath) {
        $candidate = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if ([System.IO.File]::Exists($candidate)) { $nodePath = $candidate }
    }
    if (-not $nodePath -and -not $SmokeTest) { throw '未找到 Node.js。请安装 Node.js 22 或更新版本，或从已安装 Codex 的环境启动。' }
    $workerPath = Join-Path $PSScriptRoot 'worker.mjs'
    if (-not [System.IO.File]::Exists($workerPath) -and -not $SmokeTest) { throw '找不到 worker.mjs，请将工具的全部文件放在同一文件夹。' }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Codex 白昼'
    $form.ClientSize = New-Object System.Drawing.Size(1000, 790)
    $form.MinimumSize = New-Object System.Drawing.Size(1016, 829)
    $form.MaximumSize = New-Object System.Drawing.Size(1016, 829)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#F3F5F1')
    $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Font
    $form.Icon = [System.Drawing.SystemIcons]::Application

    $null = New-TextLabel $form 'Codex 白昼' 26 20 500 42 23 '#234E3D' $true
    $null = New-TextLabel $form '把使用时间留在白天 · 自定义激活与恢复时间' 28 67 700 28 10 '#64776C'
    $script:ConnectionLabel = New-TextLabel $form '正在启动后台…' 690 36 280 30 10 '#245C46'
    $script:ConnectionLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight

    $card1 = New-Object System.Windows.Forms.Panel
    $card1.SetBounds(26, 110, 284, 157)
    $card1.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($card1)
    $null = New-TextLabel $card1 '五小时额度剩余' 18 15 250 25 10 '#64776C'
    $script:RemainingLabel = New-TextLabel $card1 '—' 16 43 250 64 35 '#245C46' $true
    $script:QuotaStatusLabel = New-TextLabel $card1 '等待首次同步' 18 119 250 24 9 '#64776C'

    $card2 = New-Object System.Windows.Forms.Panel
    $card2.SetBounds(322, 110, 322, 157)
    $card2.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($card2)
    $null = New-TextLabel $card2 '服务端恢复时间 · 本机时区' 18 15 285 25 10 '#64776C'
    $script:ResetLabel = New-TextLabel $card2 '尚未取得' 16 56 290 43 22 '#27362F' $true
    $script:CountdownLabel = New-TextLabel $card2 '等待服务端同步' 18 119 295 24 9 '#64776C'

    $card3 = New-Object System.Windows.Forms.Panel
    $card3.SetBounds(656, 110, 318, 157)
    $card3.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($card3)
    $null = New-TextLabel $card3 '下次定时激活' 18 15 280 25 10 '#64776C'
    $script:NextLabel = New-TextLabel $card3 '计划已暂停' 16 56 290 43 22 '#27362F' $true
    $script:PlanStatusLabel = New-TextLabel $card3 '设置时间后，勾选启用并保存' 18 119 292 24 9 '#64776C'

    $script:OtherQuotaLabel = New-TextLabel $form '其他额度窗口：服务端尚未返回' 28 280 640 25 9 '#64776C'
    $script:SyncedLabel = New-TextLabel $form '尚未同步额度' 650 280 324 25 9 '#64776C'
    $script:SyncedLabel.TextAlign = [System.Drawing.ContentAlignment]::TopRight

    $settingsPanel = New-Object System.Windows.Forms.Panel
    $settingsPanel.SetBounds(26, 319, 948, 201)
    $settingsPanel.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($settingsPanel)
    $null = New-TextLabel $settingsPanel '每日激活计划' 18 12 300 28 12 '#27362F' $true
    $script:EnablePlan = New-Object System.Windows.Forms.CheckBox
    $script:EnablePlan.Text = '启用定时激活'
    $script:EnablePlan.SetBounds(775, 12, 160, 27)
    $settingsPanel.Controls.Add($script:EnablePlan)
    $null = New-TextLabel $settingsPanel '激活时间' 18 53 90 24 10 '#64776C'
    $script:TimesInput = New-TextInput $settingsPanel '08:00, 13:00, 18:00' 110 49 507
    $null = New-TextLabel $settingsPanel '多个时间用逗号分隔' 635 53 285 24 9 '#64776C'
    $null = New-TextLabel $settingsPanel '允许时段' 18 95 90 24 10 '#64776C'
    $script:StartInput = New-TextInput $settingsPanel '07:00' 110 91 90
    $null = New-TextLabel $settingsPanel '至' 211 95 30 24 10 '#64776C'
    $script:EndInput = New-TextInput $settingsPanel '23:00' 242 91 90
    $null = New-TextLabel $settingsPanel '同步间隔' 380 95 90 24 10 '#64776C'
    $script:PollInput = New-Object System.Windows.Forms.NumericUpDown
    $script:PollInput.SetBounds(473, 91, 90, 30)
    $script:PollInput.Minimum = 30
    $script:PollInput.Maximum = 600
    $script:PollInput.Value = 60
    $settingsPanel.Controls.Add($script:PollInput)
    $null = New-TextLabel $settingsPanel '秒' 575 95 40 24 10 '#64776C'
    $null = New-TextLabel $settingsPanel '激活模型' 18 137 90 24 10 '#64776C'
    $script:ModelInput = New-TextInput $settingsPanel '' 110 133 507
    $script:ModelInput.MaxLength = 100
    $null = New-TextLabel $settingsPanel '留空使用可用的默认模型' 635 137 285 24 9 '#64776C'
    $null = New-TextLabel $settingsPanel '激活是一次轻量模型请求，会使用少量额度；它不能提前恢复额度，实际恢复时间以服务端为准。' 18 173 910 23 9 '#8B7758'

    $script:SaveButton = New-ActionButton $form '保存设置' 26 535 126 $true
    $script:RefreshButton = New-ActionButton $form '立即刷新额度' 164 535 140
    $script:ActivateButton = New-ActionButton $form '立即激活' 316 535 126
    $script:PauseButton = New-ActionButton $form '暂停计划' 454 535 126
    $trayButton = New-ActionButton $form '收起到托盘' 706 535 128
    $exitButton = New-ActionButton $form '退出工具' 846 535 128
    $script:ActionStatus = New-TextLabel $form '计划默认暂停。确认时间后启用并保存。' 28 584 944 25 9 '#577064'
    $script:MessageLabel = New-TextLabel $form '正在连接当前 Codex 登录…' 28 614 944 26 9 '#64776C'
    $null = New-TextLabel $form '最近活动' 28 648 300 24 10 '#27362F' $true
    $script:HistoryBox = New-Object System.Windows.Forms.TextBox
    $script:HistoryBox.SetBounds(28, 677, 944, 79)
    $script:HistoryBox.Multiline = $true
    $script:HistoryBox.ReadOnly = $true
    $script:HistoryBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $script:HistoryBox.BackColor = [System.Drawing.Color]::White
    $script:HistoryBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $script:HistoryBox.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $form.Controls.Add($script:HistoryBox)
    $null = New-TextLabel $form '仅在电脑开机且本工具运行时执行。关闭窗口即退出；最小化后继续在托盘运行。' 28 763 944 22 8 '#788A7E'

    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = [System.Drawing.SystemIcons]::Information
    $tray.Text = 'Codex 白昼'
    $tray.Visible = $true
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $showItem = $menu.Items.Add('打开额度管家')
    $pauseItem = $menu.Items.Add('暂停激活计划')
    $null = $menu.Items.Add('-')
    $quitItem = $menu.Items.Add('退出工具')
    $tray.ContextMenuStrip = $menu
    $showWindow = {
        $form.Show()
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $form.Activate()
    }
    $showItem.Add_Click($showWindow)
    $tray.Add_DoubleClick($showWindow)
    $quitItem.Add_Click({ $form.Close() })
    $exitButton.Add_Click({ $form.Close() })
    $pauseAction = {
        $script:EnablePlan.Checked = $false
        Invoke-UiCommand 'pause'
    }
    $pauseItem.Add_Click($pauseAction)
    $script:PauseButton.Add_Click($pauseAction)
    $trayButton.Add_Click({ $form.Hide() })
    $form.Add_Resize({
        if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) { $form.Hide() }
    })
    $script:SaveButton.Add_Click({
        try { Invoke-UiCommand 'saveSettings' (Read-UiSettings) }
        catch { Show-ActionError $_.Exception.Message }
    })
    $script:RefreshButton.Add_Click({ Invoke-UiCommand 'refresh' })
    $script:ActivateButton.Add_Click({ Invoke-UiCommand 'activate' })
    $form.Add_FormClosing({ $script:Closing = $true })

    if ($SmokeTest) {
        $script:State = [pscustomobject]@{
            workerPid = 0; connection = 'starting'; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
            busy = $false; quota = $null; nextActivation = $null; lastCommand = $null
            settings = [pscustomobject]@{ enabled = $false; times = @('08:00', '13:00', '18:00'); activeStart = '07:00'; activeEnd = '23:00'; pollSeconds = 60; model = '' }
            message = '界面冒烟测试：未连接账号，未触发任何模型请求。'; history = @()
        }
        Load-SettingsIntoForm $script:State.settings
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        Update-View
        Save-FormScreenshot
        Write-Output ('SmokeTest OK: ' + $ScreenshotPath)
        exit 0
    }

    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $nodePath
    $processInfo.Arguments = (ConvertTo-ProcessArgument $workerPath) + ' --data-dir ' +
        (ConvertTo-ProcessArgument $script:DataRoot) + ' --parent-pid ' + $PID
    $processInfo.WorkingDirectory = $PSScriptRoot
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $script:Worker = New-Object System.Diagnostics.Process
    $script:Worker.StartInfo = $processInfo
    if (-not $script:Worker.Start()) { throw '无法启动额度管家后台。' }
    $stdoutDrain = $script:Worker.StandardOutput.ReadToEndAsync()
    $stderrDrain = $script:Worker.StandardError.ReadToEndAsync()
    if ($VerifyConnection) {
        $script:VerifyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
        $script:ActionStatus.Text = '连接验证模式：使用隔离目录；仅读取额度，不会发送激活请求。'
        $script:SaveButton.Enabled = $false
        $script:ActivateButton.Enabled = $false
        $script:EnablePlan.Enabled = $false
    }

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({ Update-View; Test-VerificationComplete })
    $timer.Start()
    Update-View
    [System.Windows.Forms.Application]::Run($form)
    if ($VerifyConnection) {
        Write-Output ('VerifyConnection: ' + $script:VerificationResult)
        Write-Output ('Screenshot: ' + $ScreenshotPath)
        Write-Output ('Isolated data: ' + $script:DataRoot)
        exit $script:VerificationExitCode
    }
}
catch {
    if ($SmokeTest -or $VerifyConnection) {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex 白昼 · 启动失败',
        [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    if ($menu) { $menu.Dispose() }
    if ($script:Worker) {
        try {
            if (-not $script:Worker.HasExited) {
                $null = Send-WorkerCommand 'shutdown'
                if (-not $script:Worker.WaitForExit(2500)) { $script:Worker.Kill() }
            }
        }
        catch { try { $script:Worker.Kill() } catch {} }
        $script:Worker.Dispose()
    }
    if ($form) { $form.Dispose() }
    if ($script:OwnsMutex -and $script:UiMutex) { $script:UiMutex.ReleaseMutex() }
    if ($script:UiMutex) { $script:UiMutex.Dispose() }
}
