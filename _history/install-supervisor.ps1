# dsh-supervisor 安装脚本
#
# 放在 release 里由 PC 下载执行 —— 这样所有转义都在本地一次写对，
# 不用在 prompt 里跟 Windows 引号较劲（那正是上一版失败的原因）。
#
# 做四件事：下载 → 注入 token → 用 WMI 启动（脱离 dsh 的 Job）→ 注册登录自启。
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Base = 'https://github.com/184647604/dsh-plugins/releases/download/supervisor-v1',
  [string]$Dir  = "$env:USERPROFILE\.dsh\supervisor"
)

# 不用 Stop：一步失败不该让后面的步骤（尤其是自启注册和日志）全都不执行。
# 每步各自 try/catch。
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Write-Output '===== 1) 下载 ====='
Invoke-WebRequest -Uri "$Base/dsh-supervisor.js" -OutFile "$Dir\dsh-supervisor.js" -UseBasicParsing
Invoke-WebRequest -Uri "$Base/dsh-supervisor.config.template.json" -OutFile "$Dir\cfg.template.json" -UseBasicParsing
Get-ChildItem "$Dir\dsh-supervisor.js.b64","$Dir\dsh-supervisor.config.json.b64" -ErrorAction SilentlyContinue | Remove-Item -Force
"js  = " + (Get-Item "$Dir\dsh-supervisor.js").Length + " bytes"
"tpl = " + (Get-Item "$Dir\cfg.template.json").Length + " bytes"

Write-Output '===== 2) 注入 token ====='
# 必须写**无 BOM** 的 UTF-8：PS 5.1 的 Set-Content -Encoding UTF8 会加 BOM，
# 而 node 的 JSON.parse 不认 BOM。（supervisor 现在也做了容错，这里是双保险。）
$cfgText = (Get-Content "$Dir\cfg.template.json" -Raw -Encoding UTF8).Replace('__TOKEN__', $Token)
[IO.File]::WriteAllText("$Dir\dsh-supervisor.config.json", $cfgText, (New-Object Text.UTF8Encoding $false))
$cfg = Get-Content "$Dir\dsh-supervisor.config.json" -Raw | ConvertFrom-Json
"port            = " + $cfg.port
"token 长度      = " + $cfg.token.Length
"dsh.bin 存在    = " + (Test-Path $cfg.dsh.bin)
"dsh.node 存在   = " + (Test-Path $cfg.dsh.node)

Write-Output '===== 3) 语法检查 ====='
& $cfg.dsh.node --check "$Dir\dsh-supervisor.js"
"node --check exit = $LASTEXITCODE"

Write-Output '===== 4) 用 WMI 启动（关键：父进程是 WmiPrvSE，不在 dsh 的 Job 里）====='
$listening = Get-NetTCPConnection -State Listen -LocalPort $cfg.port -ErrorAction SilentlyContinue
if ($listening) {
  "已有实例在听 $($cfg.port)（pid $($listening[0].OwningProcess)），先停掉"
  Stop-Process -Id $listening[0].OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# Win32_Process.Create 的父进程是 WmiPrvSE.exe —— 在 dsh 的 Job Object 之外，
# 所以 dsh web 重启/退出都不会带走它。这是整套东西能成立的根本原因。
$node = $cfg.dsh.node
$jsPath = "$Dir\dsh-supervisor.js"
$cmdLine = '"' + $node + '" "' + $jsPath + '"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
"WMI 返回 returnValue=$($r.ReturnValue) pid=$($r.ProcessId)"

Start-Sleep -Seconds 3
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.ProcessId)" -ErrorAction SilentlyContinue
if ($p) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
  "父进程 = " + $(if ($parent) { $parent.Name } else { "已退出(pid $($p.ParentProcessId))" })
  "命令行 = " + $p.CommandLine
} else {
  "❌ pid $($r.ProcessId) 已经不在了"
}

Write-Output '===== 5) 本地探测 ====='
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/health" -Headers @{ 'x-dsh-supervisor-token' = $Token } -TimeoutSec 8
  "health = " + ($h | ConvertTo-Json -Compress)
} catch {
  "❌ health 失败: " + $_.Exception.Message
}

Write-Output '===== 6) 注册登录自启（schtasks，非管理员）====='
# 用 ScheduledTasks 模块而不是 schtasks.exe：后者的 /tr 参数要把整条命令行
# 塞进一个字符串，引号会被 PowerShell 和 schtasks 各拆一层，实测报
# "Invalid argument/option - 'Files\nodejs\node.exe ...'"。
# New-ScheduledTaskAction 的 -Execute / -Argument 是两个独立参数，没有这个问题。
try {
  # -Argument 直接传路径：它没有空格，加引号反而会被 PowerShell 当成字符串拼接
  # （写成 (""" + $jsPath + """) 实际会落成字面量 '" + path + "'，任务注册成功但登录时起不来）。
  $action  = New-ScheduledTaskAction -Execute $node -Argument $jsPath -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'dsh-supervisor' -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  '✅ 已注册登录自启任务 dsh-supervisor'
  $t = Get-ScheduledTask -TaskName 'dsh-supervisor' -ErrorAction Stop
  '状态 = ' + $t.State
  '动作 = ' + $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments
} catch {
  '❌ 注册自启失败（不影响本次运行）: ' + $_.Exception.Message
}

Write-Output '===== 7) supervisor 自己的日志 ====='
if (Test-Path "$env:USERPROFILE\.dsh\supervisor.log") {
  Get-Content "$env:USERPROFILE\.dsh\supervisor.log" -Tail 6
} else { "(暂无日志)" }
