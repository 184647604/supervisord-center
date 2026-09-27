<#
  supervisord-center - installer / migration script

  -- WHY THIS FILE IS ASCII-ONLY ------------------------------------------
  Same reason workbuddy-api.cmd and traework-api.cmd in this ecosystem are
  ASCII-only: Windows PowerShell 5.1 decodes a .ps1 file WITHOUT a UTF-8 BOM
  using the system ANSI codepage (gb2312 on this machine). Any non-ASCII text
  is then mangled, and mangled bytes can swallow a closing quote - producing
  a cascade of bogus "Missing closing '}'" parse errors at unrelated lines.

  The previous dsh-supervisor installer had a UTF-8 BOM, which is why it
  could contain Chinese. But a BOM is silently stripped by many editors and
  tooling (it was stripped twice while writing this very file), so depending
  on it is fragile. ASCII-only removes the entire failure class, works on
  PS 5.1 and PS 7 alike, and needs no encoding discipline from future editors.

  All Chinese notes live in README.md, which nothing parses as a script.

  -- WHAT IT DOES ---------------------------------------------------------
   1) Resolve paths, check sources, locate node
   2) Create runtime dir + config (REUSES the existing token by default)
   3) Syntax check (node --check)
   4) Migrate: stop old dsh-supervisor, unregister its scheduled task, archive
   5) Start via WMI (escapes the dsh Job Object) + register logon autostart
   6) Health probe

  -- USAGE ----------------------------------------------------------------
    .\install.ps1 -DryRun     # safe trial on spare port 3098, touches nothing
    .\install.ps1             # real install / migration
    .\install.ps1 -Force      # overwrite locally-modified runtime files
    .\install.ps1 -NewToken   # rotate the token (breaks cached phone tokens)
#>
[CmdletBinding()]
param(
  # Safe trial: start a throwaway instance on a spare port, then stop it.
  # Never touches the running service, the scheduled task, or port 3099.
  [switch]$DryRun,
  # Overwrite runtime files that differ from the project source.
  [switch]$Force,
  # Rotate the token instead of reusing it. Breaks any cached phone token.
  [switch]$NewToken,
  # Runtime directory (the deployment copy, independent of dsh).
  [string]$RuntimeDir = "$env:USERPROFILE\.supervisord-center",
  # Spare port used by -DryRun.
  [int]$DryRunPort = 3098
)

$ErrorActionPreference = 'Continue'
$ProjectDir = $PSScriptRoot
$SrcJs      = Join-Path $ProjectDir 'src\supervisord-center.js'
$TplJson    = Join-Path $ProjectDir 'config\cfg.template.json'

function Say  ($m) { Write-Output $m }
function Head ($m) { Write-Output ''; Write-Output "===== $m =====" }
function Warn ($m) { Write-Output "  [!] $m" }
function Ok   ($m) { Write-Output "  [ok] $m" }

# --- temp-dir cleanup ------------------------------------------------------
# DryRun writes a trial copy to TEMP. That copy must never outlive the run,
# on ANY exit path. A PowerShell `trap` does NOT cover this: `exit N` is not
# a terminating error, so it bypasses the trap entirely (verified by forcing
# a mid-script failure - the trial dir survived). So use an explicit helper
# and call it before every exit, plus sweep stale dirs at startup to catch
# the paths that cannot call it (Ctrl+C, kill, host crash).
$DryRunDir = $null

function Remove-TrialDir {
  if ($DryRunDir -and (Test-Path $DryRunDir)) {
    Remove-Item $DryRunDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Sweep leftovers from previous runs. Only touch dirs older than an hour, so
# a concurrently running install is never stomped.
Get-ChildItem $env:TEMP -Filter 'sdc-dryrun-*' -Force -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

Say 'supervisord-center installer'
Say "  project dir : $ProjectDir"
Say "  runtime dir : $RuntimeDir"
if ($DryRun) { Say "  mode        : DRY RUN (spare port $DryRunPort, touches nothing)" }

# ---------------------------------------------------------------------------
Head '1) Check sources'

if (-not (Test-Path $SrcJs))   { Say "  [x] missing $SrcJs"; Remove-TrialDir; exit 1 }
if (-not (Test-Path $TplJson)) { Say "  [x] missing $TplJson"; Remove-TrialDir; exit 1 }
Ok "main script  $((Get-Item $SrcJs).Length) bytes"
Ok "config tpl   $((Get-Item $TplJson).Length) bytes"

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { Say "  [x] node.exe not found"; Remove-TrialDir; exit 1 }
Ok "node         $Node"

# ---------------------------------------------------------------------------
Head '2) Prepare runtime dir + config'

# DryRun must be side-effect free: creating the runtime dir here would leave
# an empty ~/.supervisord-center behind even though the trial writes only to
# TEMP. So only create it for a real install.
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir 'logs') | Out-Null
}
$RuntimeJs  = Join-Path $RuntimeDir 'supervisord-center.js'
$RuntimeCfg = Join-Path $RuntimeDir 'supervisord-center.config.json'

# --- token policy ----------------------------------------------------------
# Reuse the existing token by default. The phone app caches the supervisor
# address + token while dsh is still alive (it has nowhere else to ask once
# dsh is dead). Rotating on every reinstall would silently invalidate that
# cache exactly when it is needed most. Rotate only on explicit -NewToken.
#
# Check the NEW path first, then the LEGACY dsh-supervisor path. The legacy
# check is what makes the very first migration preserve the token: at that
# moment the new config does not exist yet and the token only lives in
# ~/.dsh/supervisor/dsh-supervisor.config.json. Without it, migrating would
# silently mint a fresh token and break every cached phone credential.
$Token = $null
$TokenSources = @(
  $RuntimeCfg,
  (Join-Path $env:USERPROFILE '.dsh\supervisor\dsh-supervisor.config.json')
)
foreach ($src in $TokenSources) {
  if ($NewToken) { break }
  if (-not (Test-Path $src)) { continue }
  try {
    # TrimStart, not .Replace([char]0xFEFF, ''): Replace(char,char) requires a
    # char, and an empty string throws "String must be exactly one character
    # long" (hit this during testing).
    $old = ((Get-Content $src -Raw -Encoding UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
    if ($old.token -and $old.token -ne '__TOKEN__') {
      $Token = $old.token
      $isLegacy = $src -eq $TokenSources[1]
      Ok "reusing existing token from $(if ($isLegacy) { 'LEGACY dsh-supervisor config' } else { 'existing config' }) (length $($Token.Length))"
      break
    }
  } catch { Warn "config unreadable at $src : $($_.Exception.Message)" }
}
if (-not $Token) {
  $bytes = New-Object 'byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Token = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')
  Ok "generated new token (length $($Token.Length))"
}

# Count the placeholders BEFORE substituting, then assert none survive.
#
# This is not paranoia: the first version of the template mentioned the
# placeholder inside its own "_comment" text, which sits ABOVE the real token
# field. A single .Replace() therefore substituted the COMMENT and left the
# actual token as the literal placeholder -- a config that parses fine, looks
# fine at a glance, and is silently unauthenticated. Verified by reproducing
# it. So: require exactly one occurrence, and require zero afterwards.
$ph = '__TOKEN__'
$phCount = ([regex]::Matches((Get-Content $TplJson -Raw -Encoding UTF8), [regex]::Escape($ph))).Count
if ($phCount -ne 1) {
  Say "  [x] template must contain exactly one $ph placeholder, found $phCount"
  Say '      (a placeholder inside a comment is substituted first and silently wins)'
  Remove-TrialDir
  exit 1
}
$cfgText = (Get-Content $TplJson -Raw -Encoding UTF8).Replace($ph, $Token)
if ($cfgText.Contains($ph)) { Say "  [x] $ph survived substitution"; Remove-TrialDir; exit 1 }

# --- local-modification guard ---------------------------------------------
# Refuse to clobber a runtime file that differs from the source. The old
# installer had no such check, so hand-editing the runtime copy and then
# re-running install silently discarded the edit.
if ((Test-Path $RuntimeJs) -and -not $Force) {
  $srcHash = (Get-FileHash $SrcJs -Algorithm SHA256).Hash
  $runHash = (Get-FileHash $RuntimeJs -Algorithm SHA256).Hash
  if ($srcHash -ne $runHash) {
    Warn 'runtime copy differs from project source:'
    Say  "          source  : $srcHash"
    Say  "          runtime : $runHash"
    Say  '        Someone edited the runtime file by hand, most likely.'
    Say  '        Pass -Force to overwrite, or merge the change back into src/ first.'
    if (-not $DryRun) { exit 2 }
    Warn '(DryRun: continuing, but the runtime dir will not be written)'
  } else {
    Ok 'runtime file matches source'
  }
}

# --- write files (BOM-less UTF-8) -----------------------------------------
# Config must be BOM-less: JSON.parse rejects U+FEFF. (The script itself also
# strips a BOM defensively - belt and braces.)
if ($DryRun) {
  $DryRunDir = Join-Path $env:TEMP "sdc-dryrun-$PID"
  New-Item -ItemType Directory -Force -Path $DryRunDir | Out-Null

  [IO.File]::WriteAllText((Join-Path $DryRunDir 'supervisord-center.js'), (Get-Content $SrcJs -Raw -Encoding UTF8), (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $DryRunDir 'supervisord-center.config.json'), $cfgText, (New-Object Text.UTF8Encoding $false))
  $TestJs  = Join-Path $DryRunDir 'supervisord-center.js'
  $TestCfg = Join-Path $DryRunDir 'supervisord-center.config.json'
  Ok "trial copy written to $DryRunDir"
} else {
  [IO.File]::WriteAllText($RuntimeJs,  (Get-Content $SrcJs -Raw -Encoding UTF8), (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText($RuntimeCfg, $cfgText, (New-Object Text.UTF8Encoding $false))
  $TestJs  = $RuntimeJs
  $TestCfg = $RuntimeCfg
  Ok "written to $RuntimeDir"
}

try {
  $p = ((Get-Content $TestCfg -Raw -Encoding UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
  Ok "config parses: port=$($p.port) host=$($p.host) tokenLen=$($p.token.Length)"
  # An unsubstituted token is not a cosmetic problem: the server treats a
  # literal placeholder as a perfectly valid non-empty token, starts happily,
  # and is then authenticated by a value that is printed in the template. Fail
  # on both the placeholder and an empty value.
  if (-not $p.token -or $p.token -eq '__TOKEN__') {
    Say "  [x] token was not substituted (token='$($p.token)') - refusing to continue"
    Remove-TrialDir
    exit 1
  }
  if ($p.services) { Ok "config declares $($p.services.Count) services: $(($p.services | ForEach-Object { $_.id }) -join ', ')" }
} catch { Say "  [x] config parse failed: $($_.Exception.Message)"; Remove-TrialDir; exit 1 }

# ---------------------------------------------------------------------------
Head '3) Syntax check'
& $Node --check $TestJs
if ($LASTEXITCODE -ne 0) { Say "  [x] node --check failed (exit $LASTEXITCODE)"; Remove-TrialDir; exit 1 }
Ok 'node --check passed'

# ---------------------------------------------------------------------------
if ($DryRun) {
  Head '4) DRY RUN: throwaway instance on a spare port'

  # Point the trial at a DEAD target (port 8001, nothing listening) so the
  # liveness probe must report running:false. That proves the probe actually
  # works, while guaranteeing this dry run can never start a second service.
  #
  # Schema-aware on purpose. The old single-service version just set
  # $tmp.dsh.port = 8001. After the move to services[], that line became a
  # silent no-op: the property no longer exists, PowerShell creates nothing on
  # a PSCustomObject, and the trial happily probed the REAL port -- so the
  # "dead target" assertion passed while testing nothing at all. Caught only
  # because the dry run printed running:true. Rewrite every service, and fail
  # loudly if neither shape is present rather than falling through.
  $tmp = ($cfgText | ConvertFrom-Json)
  $tmp.port = $DryRunPort
  $deadPort = 8001
  if ($tmp.PSObject.Properties.Name -contains 'services') {
    $i = 0
    foreach ($svc in $tmp.services) {
      $i++
      $svc.port = $deadPort + $i          # 8002, 8003, ... all dead
      # via=node only: a cmd trial would spawn a real console wrapper. The
      # point here is to exercise the HTTP surface, not to launch anything.
      $svc.via = 'node'
      $svc.healthPath = ''
      $svc.autostart = $false
    }
    $probePort = $deadPort + 1
    Say "  trial: $($tmp.services.Count) services remapped to dead ports $($deadPort + 1).."
  } elseif ($tmp.PSObject.Properties.Name -contains 'dsh') {
    $tmp.dsh.port = $deadPort
    $probePort = $deadPort
    Warn 'config still uses the legacy single-service "dsh" shape'
  } else {
    Say '  [x] config has neither "services" nor "dsh" - cannot build a trial'
    Remove-TrialDir
    exit 1
  }
  # Add-Member, not `$tmp.log = ...`: the template has no "log" key, and
  # assigning a brand-new property to a PSCustomObject throws
  # "The property 'log' cannot be found on this object".
  $tmp | Add-Member -NotePropertyName log -NotePropertyValue (Join-Path $env:TEMP "sdc-dryrun-$PID\dryrun.log") -Force
  [IO.File]::WriteAllText($TestCfg, ($tmp | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))

  $proc = Start-Process -FilePath $Node -ArgumentList "`"$TestJs`"" -PassThru -WindowStyle Hidden
  Say "  trial instance pid=$($proc.Id), waiting for listener..."
  Start-Sleep -Seconds 3

  $hdr = @{ 'x-supervisord-center-token' = $Token }
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$DryRunPort/health" -Headers $hdr -TimeoutSec 8
    Ok "/health -> $($h | ConvertTo-Json -Compress)"
    if ($h.running -eq $false -and $h.targetPort -eq $probePort) {
      Ok "liveness probe correct (dead target $probePort reported running:false)"
    } else {
      Say "  [x] liveness probe looks wrong: expected running=false on dead port $probePort," +
          " got running=$($h.running) targetPort=$($h.targetPort)"
      Say '      A running=true here means the trial is probing a REAL port, so this check'
      Say '      proves nothing. Refusing to report success.'
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Remove-TrialDir
      exit 1
    }
  } catch { Warn "health failed: $($_.Exception.Message)" }

  # The multi-service surface is the whole point of the new version, so the
  # dry run exercises it too rather than only the legacy single-service /health.
  try {
    $svc = Invoke-RestMethod "http://127.0.0.1:$DryRunPort/services" -Headers $hdr -TimeoutSec 12
    Ok "/services -> $($svc.services.Count) services, all offline as expected: " +
       (($svc.services | ForEach-Object { "$($_.id)=$($_.running)" }) -join ' ')
    $anyUp = @($svc.services | Where-Object { $_.running }).Count
    if ($anyUp -gt 0) {
      Say "  [x] $anyUp trial service(s) reported online - they were remapped to dead ports!"
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Remove-TrialDir
      exit 1
    }
  } catch { Warn "/services failed: $($_.Exception.Message)" }

  try {
    $null = Invoke-RestMethod "http://127.0.0.1:$DryRunPort/health" -TimeoutSec 8
    Say '  [x] request WITHOUT token succeeded - auth is broken!'
  } catch {
    $c = $_.Exception.Response.StatusCode.value__
    if ($c -eq 401) { Ok 'no-token request correctly rejected with 401' } else { Warn "no-token returned $c (expected 401)" }
  }

  try {
    $null = Invoke-RestMethod "http://127.0.0.1:$DryRunPort/health?token=$Token" -TimeoutSec 8
    Say '  [x] ?token= succeeded - should be rejected!'
  } catch {
    $c = $_.Exception.Response.StatusCode.value__
    if ($c -eq 401) { Ok '?token= correctly rejected (headers only)' } else { Warn "?token= returned $c (expected 401)" }
  }

  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-TrialDir
  Ok 'trial instance stopped, trial dir removed'
  Say ''
  Say 'DRY RUN complete. Running service and scheduled tasks untouched.'
  Say 'Drop -DryRun to install for real.'
  exit 0
}

# ---------------------------------------------------------------------------
Head '4) Migrate: stop the old dsh-supervisor'

# The old instance holds the same port, so it must go first or the new one
# fails with EADDRINUSE. Done only AFTER the replacement passed syntax check.
$oldListener = Get-NetTCPConnection -State Listen -LocalPort $p.port -ErrorAction SilentlyContinue
if ($oldListener) {
  $oldPid = $oldListener[0].OwningProcess
  $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  Warn "port $($p.port) held by pid=$oldPid, stopping it"
  try {
    $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid").CommandLine
    Say "        its command line: $cmdline"
  } catch { }
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Ok 'old instance stopped'
} else {
  Ok "port $($p.port) is free, nothing to stop"
}

$oldTask = Get-ScheduledTask -TaskName 'dsh-supervisor' -ErrorAction SilentlyContinue
if ($oldTask) {
  Unregister-ScheduledTask -TaskName 'dsh-supervisor' -Confirm:$false -ErrorAction SilentlyContinue
  Ok 'unregistered old scheduled task dsh-supervisor'
} else { Ok 'no old scheduled task to clean up' }

# Archive (never delete) the old runtime dir so rollback stays possible.
$OldDir = "$env:USERPROFILE\.dsh\supervisor"
if (Test-Path $OldDir) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Archive = Join-Path $RuntimeDir "_archive-dsh-supervisor-$stamp"
  New-Item -ItemType Directory -Force -Path $Archive | Out-Null
  Copy-Item "$OldDir\*" -Destination $Archive -Recurse -Force -ErrorAction SilentlyContinue
  Ok "old files archived to $Archive (original dir left in place)"
}

# ---------------------------------------------------------------------------
Head '5) Start via WMI (escapes the dsh Job Object)'

# Win32_Process.Create makes the parent WmiPrvSE.exe, outside the Job Object
# that dsh uses to reap its children - which is the whole reason this works.
$cmdLine = '"' + $Node + '" "' + $TestJs + '"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
Say "  WMI returned returnValue=$($r.ReturnValue) pid=$($r.ProcessId)"
if ($r.ReturnValue -ne 0) { Say '  [x] WMI create failed'; exit 1 }

Start-Sleep -Seconds 3
$newProc = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.ProcessId)" -ErrorAction SilentlyContinue
if ($newProc) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($newProc.ParentProcessId)" -ErrorAction SilentlyContinue
  $pname = if ($parent) { $parent.Name } else { "already exited (pid $($newProc.ParentProcessId))" }
  Ok "parent process = $pname  (should be svchost/WmiPrvSE, never dsh)"
} else {
  Say "  [x] pid $($r.ProcessId) is already gone (crashed on start? check the log)"
  $lg = Join-Path $RuntimeDir 'logs\center.log'
  if (Test-Path $lg) { Get-Content $lg -Tail 10 }
  exit 1
}

# ---------------------------------------------------------------------------
Head '6) Health probe'

$hdr = @{ 'x-supervisord-center-token' = $Token }
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$($p.port)/health" -Headers $hdr -TimeoutSec 10
  Ok "/health -> $($h | ConvertTo-Json -Compress)"
} catch {
  Warn "health failed: $($_.Exception.Message)"
  $lg = Join-Path $RuntimeDir 'logs\center.log'
  if (Test-Path $lg) { Get-Content $lg -Tail 10 }
}

# ---------------------------------------------------------------------------
Head '7) Register logon autostart (ScheduledTasks, non-admin)'

# ScheduledTasks module rather than schtasks.exe: the latter's /tr takes one
# string, and quotes get unwrapped once by PowerShell and again by schtasks,
# which produced "Invalid argument/option - 'Files\nodejs\node.exe ...'".
# New-ScheduledTaskAction takes -Execute and -Argument separately.
try {
  # -Argument takes the raw path: it has no spaces, and quoting it makes
  # PowerShell emit the literal '" + path + "', registering a task that cannot
  # start at logon.
  $action   = New-ScheduledTaskAction -Execute $Node -Argument $TestJs -WorkingDirectory $RuntimeDir
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'supervisord-center' -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  Ok 'registered logon autostart task supervisord-center'
  $t = Get-ScheduledTask -TaskName 'supervisord-center' -ErrorAction Stop
  Say "        state  = $($t.State)"
  Say "        action = $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
} catch {
  Warn "autostart registration failed (does not affect this run): $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
Head 'Done'
Say ''
Say "  local control plane : http://127.0.0.1:$($p.port)"
Say "  tailnet             : https://<your-node>.ts.net/super  (existing mapping, unchanged)"
Say "  token               : $Token"
Say ''
Say '  Next steps (the Tailscale mapping is unchanged, so usually nothing to do):'
Say "    tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:$($p.port)"
Say '    tailscale serve status'
Say ''
Say '  WARNING: dsh-plugin-center hardcodes the OLD config path in its'
Say '  center.supervisor endpoint (~/.dsh/supervisor/dsh-supervisor.config.json).'
Say '  That endpoint breaks after the rename. See README section "Known coupling".'
