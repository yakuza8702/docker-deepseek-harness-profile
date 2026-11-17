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

Step 'clipboard-tasks' {
  # U2: THE CLIPBOARD BRIDGE, SESSION 2 ONLY.
  #
  # The RFB route (ClientCutText) is dead here: the Windows guest runs a bare
  # QEMU VNC server with NO clipboard agent, so a ClientCutText is accepted by
  # QEMU and dropped by the desktop — a human who pasted got the guest's OLD
  # clipboard, not the text that was sent. `Set-Clipboard` over SSH is dead for
  # the same reason the desktop is unreachable from SSH: sshd runs in Session 0,
  # which owns a different (empty) clipboard than the interactive session the
  # user sees.
  #
  # So the clipboard is moved by TWO on-demand tasks, each of which runs
  # `/it` — IN THE INTERACTIVE USER SESSION — which is the only place
  # `Set-Clipboard` / `Get-Clipboard` mean anything:
  #
  #   cua-clip-set   C:\ProgramData\cua\clip.txt      -> clipboard
  #   cua-clip-get   clipboard                        -> C:\ProgramData\cua\clip-read.txt
  #
  # The supervisor writes clip.txt over its SSH/scp channel, runs the task, and
  # (for the read direction) copies clip-read.txt back. Both task bodies live in
  # .ps1 files rather than inline in /tr, because /tr is ONE command line that
  # Windows re-parses: a nested quote there silently truncates the command, and
  # the failure mode is a task that exists and does nothing.
  New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua' | Out-Null
  # The clip files are readable by the interactive user AND by sshd (which opens
  # them as the same account, `cua`). icacls is the Windows form of 0644: the
  # `cua` account owns the directory and Everyone gets read on the two files.
  icacls 'C:\ProgramData\cua' /grant '*S-1-1-0:(OI)(CI)R' /T /C | Out-Null

  $setScript = 'C:\ProgramData\cua\clip-set.ps1'
  $getScript = 'C:\ProgramData\cua\clip-get.ps1'
  Set-Content -Path $setScript -Encoding ASCII -Value @'
# U2: paste C:\ProgramData\cua\clip.txt onto THIS session's clipboard.
Set-Clipboard -Value ([IO.File]::ReadAllText('C:\ProgramData\cua\clip.txt'))
'@
  Set-Content -Path $getScript -Encoding ASCII -Value @'
# U2: capture THIS session's clipboard into C:\ProgramData\cua\clip-read.txt.
[IO.File]::WriteAllText('C:\ProgramData\cua\clip-read.txt', [string](Get-Clipboard -Raw))
'@

  # /it = interactive (runs in the logged-on user's session), /rl LIMITED = the
  # same token the user's own PowerShell gets (no elevation, which would put the
  # task on a different desktop), /sc ondemand = only when the supervisor asks.
  #
  # WHY THROUGH A .cmd FILE: Windows PowerShell 5.1 passes a variable containing
  # spaces to a native program WITHOUT quoting it, so `& schtasks /tr $setTr`
  # arrives as `/tr powershell.exe -NoProfile ...` and schtasks takes only
  # `powershell.exe` as the action. The two /tr values therefore go through a
  # batch file, which cmd parses the documented way (quoted argument). Same
  # reason the bodies live in .ps1 files instead of inline /tr text.
  $trSet = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $setScript"
  $trGet = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $getScript"
  $cmdFile = Join-Path $env:TEMP 'cua-clip-tasks.cmd'
  @(
    "schtasks /create /tn `"cua-clip-set`" /sc ondemand /it /rl LIMITED /f /tr `"$trSet`""
    "schtasks /create /tn `"cua-clip-get`" /sc ondemand /it /rl LIMITED /f /tr `"$trGet`""
  ) | Set-Content -Path $cmdFile -Encoding ASCII
  & cmd /c $cmdFile
  $tasksExit = $LASTEXITCODE
  Remove-Item -Force $cmdFile -ErrorAction SilentlyContinue
  if ($tasksExit -ne 0) { throw "schtasks could not register the clipboard tasks (exit $tasksExit)" }
  Say 'clipboard tasks registered (cua-clip-set, cua-clip-get: ondemand, interactive, hidden)'
}

# THE STEP IS RENAMED ON PURPOSE. It used to be `autostart-task`, and a computer
# whose marker already says `autostart-task: ok` would SKIP its body — i.e. every
# machine that has the visible console window would keep it. A new key re-runs
# exactly the one step whose old result is the bug, and leaves the expensive
# steps (OpenSSH, python, pip) skipped as before.
Step 'autostart-windowless' {
  # THE INTERACTIVE SESSION, WITHOUT A CONSOLE WINDOW.
  #
  # `dsh-cua-server` must run in the logged-on user's session: pywinauto cannot
  # see windows from Session 0, where SSH lands. A task triggered `AtLogOn` of
  # `cua` is the only reliable way to get that session.
  #
  # U3: WHAT USED TO BE WRONG, TWICE.
  #
  #   1. It ran `python.exe`, which ALWAYS allocates a console. The task was
  #      registered with Hidden=False, so every logon left a permanently blank,
  #      visible console window on the desktop — the reported defect. The fix is
  #      `pythonw.exe` (the windowless interpreter that ships beside python.exe)
  #      plus `-Hidden` on the task itself; if an unusual install has no
  #      pythonw.exe, a `powershell -WindowStyle Hidden` wrapper gets the same
  #      result.
  #   2. It passed `--pipe \\.\pipe\dsh-cua`, an argument that does not exist:
  #      upstream `dsh_cua.server main()` takes no pipe option. The named pipe
  #      in win-mcp.js's diagram was therefore never created — the SSH side
  #      starts its OWN stdio server per session, and the two never met. The
  #      argument is gone rather than documented as broken.
  #
  # WHAT THIS MEANS, HONESTLY: with a stdio-only upstream, ONE shared session-2
  # server cannot be reached over SSH yet. The MCP attach keeps working as it
  # really does — an independent stdio server per SSH session (19 tools) — and
  # the clipboard/session-2 features need either these on-demand tasks (which
  # they now have) or an upstream pipe server (which does not exist). See
  # plugins/dsh-cua-vm/README.md and REPORT.md.
  $py = Get-RealPython
  if (-not $py) { throw 'python is missing: cannot register the dsh-cua task' }
  $pyw = Join-Path (Split-Path -Parent $py) 'pythonw.exe'
  if (Test-Path $pyw) {
    $action = New-ScheduledTaskAction -Execute $pyw -Argument '-m dsh_cua.server'
    Say "dsh-cua-server will run windowless: $pyw -m dsh_cua.server"
  } else {
    # No pythonw.exe (an embeddable distribution, an unusual layout): a hidden
    # PowerShell wrapper still runs python without a visible console.
    $inner = "& '$py' -m dsh_cua.server"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$inner`""
    Say "pythonw.exe is missing; dsh-cua-server runs under a hidden powershell wrapper"
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'cua'
  $principal = New-ScheduledTaskPrincipal -UserId 'cua' -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  # END the old instance first: a task already running (registered by a previous
  # firstboot with a visible console) cannot be replaced in place, and leaving it
  # running keeps the blank window the user reported.
  & schtasks /end /tn 'dsh-cua-server' 2>$null | Out-Null
  Unregister-ScheduledTask -TaskName 'dsh-cua-server' -Confirm:$false -ErrorAction SilentlyContinue
  # `-Hidden` is the task-level flag: Task Scheduler never shows the task's
  # process window, even for a launcher that would otherwise create one.
  Register-ScheduledTask -TaskName 'dsh-cua-server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Hidden -Force | Out-Null
  Start-ScheduledTask -TaskName 'dsh-cua-server'
  Say 'dsh-cua-server task registered (interactive, windowless)'
}

$state.finished = (Get-Date).ToString('o')
$state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
Say 'DONE'
