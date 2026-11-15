<#
  cua-firstboot.ps1 — everything a fresh Windows computer needs to be usable by
  the harness, in one idempotent script.

  WHAT IT INSTALLS (all of it needed, none of it optional):

    OpenSSH.Server   the transport for cua_vm_exec / cua_vm_put / cua_vm_get.
                     A Windows guest has no cua sandbox agent, so SSH IS the
                     agent surface; without it those tools refuse.
    python.org       the runtime for dsh-cua (there is no reliable winget in a
                     fresh eval image without the Store).
    dsh-cua          the UI-automation server (pywinauto) the harness drives.
    a scheduled task  dsh-cua-server in the INTERACTIVE session at logon.
                     SSH lands in Session 0 with no desktop; pywinauto can only
                     drive windows in the user's own session, so the SSH side
                     proxies to this listener instead of driving the desktop
                     itself.

  It writes C:\cua-provision.json as an AUDIT marker: it records which steps
  succeeded and when, so a human (or a later `cua_vm_exec 'type
  C:\cua-provision.json'`) can see what the install actually did. Readiness is
  NOT derived from it — `vmWindowsStatus` waits for the SSH banner, which only
  exists once the `openssh` step has run.
#>
param([switch]$Force)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$logDir = 'C:\Windows\Setup\Scripts'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'cua-firstboot.log'
function Say([string]$m) { "$(Get-Date -Format o) $m" | Tee-Object -FilePath $log -Append }

$marker = 'C:\cua-provision.json'

# THIS SCRIPT RUNS TWICE: once as SYSTEM from setupcomplete.cmd (the end of
# Setup) and once as `cua` from FirstLogonCommands. Installing OpenSSH, python
# and the scheduled task twice is wasteful at best and fights itself at worst
# (a second `pip install` while the first holds the wheel cache, a second
# Register-ScheduledTask on a running one). The marker makes it idempotent: a
# stage that already succeeded is SKIPPED, and -Force re-runs everything.
$state = @{ started = (Get-Date).ToString('o'); steps = @() }
if (Test-Path $marker) {
  try {
    $previous = Get-Content $marker -Raw | ConvertFrom-Json
    if ($previous -and $previous.steps) { $state.steps = @($previous.steps) }
  } catch { Say "marker unreadable, starting fresh: $($_.Exception.Message)" }
}
$done = @{}
foreach ($step in $state.steps) { if ($step.ok -eq $true) { $done[$step.step] = $true } }
if ($Force) { $done = @{}; $state.steps = @() }

function Step([string]$name, [scriptblock]$body) {
  if ($done.ContainsKey($name)) { Say "== $name (already done, skipped)"; return }
  Say "== $name"
  try {
    & $body
    $state.steps += @{ step = $name; ok = $true }
  } catch {
    Say "FAILED $name : $($_.Exception.Message)"
    $state.steps += @{ step = $name; ok = $false; error = $_.Exception.Message }
  }
  $state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
}

# M2: `Get-Command python` on Windows 11 happily returns the WindowsApps
# App Execution Alias — a 0-byte stub that opens the Store instead of running
# Python. Installing "succeeded", pip then failed, and the whole dsh-cua step
# died. Only a real interpreter (outside \WindowsApps) counts.
function Get-RealPython {
  foreach ($candidate in @(Get-Command python -All -ErrorAction SilentlyContinue)) {
    if ($candidate.Source -and $candidate.Source -notmatch '\\WindowsApps\\') { return $candidate.Source }
  }
  return $null
}

Step 'openssh' {
  # The capability is in the image; no internet needed for this step.
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  if ($cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
  }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  New-Item -ItemType Directory -Force -Path 'C:\ProgramData\ssh' | Out-Null
  # Host keys are generated on first start; the daemon needs a restart after.
  Restart-Service sshd
  # Authorize the supervisor's key for BOTH the cua user and the admin group,
  # because Windows OpenSSH reads administrators_authorized_keys for admin users.
  $keys = @'
{{SSH_PUBKEY}}
'@
  $adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
  Set-Content -Path $adminKeys -Value $keys -Encoding ASCII
  icacls $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  $userDir = 'C:\Users\cua\.ssh'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Set-Content -Path (Join-Path $userDir 'authorized_keys') -Value $keys -Encoding ASCII
  # Password auth stays on: the generated password is the fallback when the key
  # is lost, and the panel reveals it.
  $cfg = 'C:\ProgramData\ssh\sshd_config'
  if (Test-Path $cfg) {
    (Get-Content $cfg) -replace '^#?PasswordAuthentication.*', 'PasswordAuthentication yes' |
      Set-Content $cfg -Encoding ASCII
    Restart-Service sshd
  }
  New-NetFirewallRule -DisplayName 'cua ssh' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -ErrorAction SilentlyContinue | Out-Null
  Say "sshd: $((Get-Service sshd).Status)"
}

Step 'python' {
  $py = Get-RealPython
  if (-not $py) {
    $installer = Join-Path $env:TEMP 'python-setup.exe'
    Invoke-WebRequest -Uri '{{PYTHON_URL}}' -OutFile $installer -UseBasicParsing
    Start-Process -FilePath $installer -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_pip=1 Include_test=0' -Wait
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $py = Get-RealPython
  }
  if (-not $py) { throw 'no real python after install (only the WindowsApps App Execution Alias?)' }
  Say "python: $py"
}

Step 'dsh-cua' {
  $py = Get-RealPython
  if (-not $py) { throw 'python is missing: the python step did not produce a real interpreter' }
  & $py -m pip install --disable-pip-version-check --no-input '{{DSH_CUA_PIP}}'
  $mod = & $py -c "import importlib.util,sys; print('yes' if importlib.util.find_spec('dsh_cua') else 'no')"
  if ($mod.Trim() -ne 'yes') { throw 'dsh-cua did not import after pip install' }
}

Step 'autostart-task' {
  # THE INTERACTIVE SESSION. `dsh-cua-server` opens a local named pipe; the SSH
  # side (Session 0, no desktop) proxies stdio to it. A task that runs "at
  # logon" of the cua user is the only way to guarantee the desktop session.
  $py = Get-RealPython
  if (-not $py) { throw 'python is missing: cannot register the dsh-cua task' }
  $action = New-ScheduledTaskAction -Execute $py -Argument '-m dsh_cua.server --pipe \\.\pipe\dsh-cua'
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'cua'
  $principal = New-ScheduledTaskPrincipal -UserId 'cua' -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName 'dsh-cua-server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'dsh-cua-server'
  Say 'dsh-cua-server task registered (interactive)'
}

$state.finished = (Get-Date).ToString('o')
$state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
Say 'DONE'
