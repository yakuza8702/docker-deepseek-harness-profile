<#
  cua-firstboot.ps1 - everything a fresh Windows computer needs to be usable by
  the harness, in one idempotent script.

  WHAT IT INSTALLS (all of it needed, none of it optional):

    OpenSSH.Server   the transport for cua_vm_exec / cua_vm_put / cua_vm_get.
                     A Windows guest has no cua sandbox agent, so SSH IS the
                     agent surface; without it those tools refuse.
    python.org       the runtime for dsh-cua (there is no reliable winget in a
                     fresh eval image without the Store).
    dsh-cua          the UI-automation server (pywinauto) the harness drives,
                     installed at the PINNED build and with its python
                     dependency VERIFIED BY IMPORT: a resolved wheel whose pywin32
                     DLLs were never copied passes `find_spec` and dies at tool
                     time, so the step asserts and repairs (see step `dsh-cua`).
    C:\cua-work      the one directory the DESKTOP token can write. The desktop
                     runs the user's filtered token at Medium integrity and the
                     profile root inherits a DACL that refuses it - the reported
                     PermissionError on a save path. Created with an explicit
                     DACL and a Medium label, re-measured by the relay at every
                     start (see step `cua-workdir`).
    the scale fix    upstream computes `scale_x/scale_y` from the WINDOW while the
                     image is a client-area CROP, so the two disagree with
                     `scale` by construction. Corrected in place under a
                     version + SHA-256 + anchor gate and proven by a probe with no
                     window; a refused gate is reported, never faked (see step
                     `dsh-cua-scale`).
    a scheduled task  dsh-cua-server in the INTERACTIVE session at logon.
                     SSH lands in Session 0 with no desktop; pywinauto can only
                     drive windows in the user's own session, so the SSH side
                     proxies to this listener instead of driving the desktop
                     itself.

  It writes C:\cua-provision.json as an AUDIT marker: it records which steps
  succeeded and when, so a human (or a later `cua_vm_exec 'type
  C:\cua-provision.json'`) can see what the install actually did. Readiness is
  NOT derived from it - `vmWindowsStatus` waits for the SSH banner, which only
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

# ---------------------------------------------------------------------------
# P3 - IDENTITY. The marker below records what ran; without these two keys it
# cannot say WHICH firstboot ran. On a guest that has been through two passes and
# a reboot, "the fix did not work" and "the fix was never staged" look identical
# (the live guest carried a 46,955-byte script where the repository had 46,830),
# and every stale-payload fix reads as a non-fix. scriptSha256 is the hash of the
# file being executed right now - $PSCommandPath, not a guessed path - so the
# marker, `Get-FileHash` on the payload, and the repository's own copy can be
# compared byte for byte. scriptVersion is bumped by hand when the provisioning
# contract changes; the hash is what proves identity, the number is for humans.
#
# An empty hash is recorded as '' rather than omitted: a reader must be able to
# tell "this script could not hash itself" from "this marker predates the field".
# ---------------------------------------------------------------------------
# WP-1A (RC-1): 1.3.0. A PROVISIONING-CONTRACT CHANGE, so the payload's own number
# moves: the marker gains a top-level `guardSha256`, and the guard/launcher steps
# become measure-then-write so a re-entry cannot overwrite a repair. This is the
# GUEST's number, not the plugin's - a harness reports its `PLUGIN_VERSION` and the
# guest reports this; the two are compared only through `payload.stale`.
$scriptVersion = '1.3.0'
$scriptSha256 = ''
try {
  if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath -ErrorAction Stop)) {
    $scriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} catch {
  Say "identity: could not hash $PSCommandPath : $($_.Exception.Message)"
  $scriptSha256 = ''
}

# THIS SCRIPT RUNS TWICE: once as SYSTEM from setupcomplete.cmd (the end of
# Setup) and once as `cua` from FirstLogonCommands. Installing OpenSSH, python
# and the scheduled task twice is wasteful at best and fights itself at worst
# (a second `pip install` while the first holds the wheel cache, a second
# Register-ScheduledTask on a running one). The marker makes it idempotent: a
# stage that already succeeded is SKIPPED, and -Force re-runs everything.
# THE TOP-LEVEL IDENTITY FIELDS ARE THE HARNESS'S COMPARISON, NOT DECORATION.
# `scriptSha256` is the hash of the file being executed, so `payload.stale` is a
# field comparison against the payload a computer was provisioned with instead of
# the byte-count archaeology the diagnosis had to do; `scriptVersion` is the
# one-line answer to "which provisioning contract is this guest running". Both live
# at the TOP level (not only inside a step row) for exactly that reason, and
# `guardSha256` joins them at the end of the run.
$state = @{ started = (Get-Date).ToString('o'); scriptVersion = $scriptVersion; scriptSha256 = $scriptSha256; steps = @() }
if (Test-Path $marker) {
  try {
    $previous = Get-Content $marker -Raw | ConvertFrom-Json
    if ($previous -and $previous.steps) { $state.steps = @($previous.steps) }
  } catch { Say "marker unreadable, starting fresh: $($_.Exception.Message)" }
}
$done = @{}
# A `skipped` entry is ok:true but NOT done: the privacy off-switch (J20-1b) is
# re-checked on every run, so removing the sentinel registers and starts the
# task without needing -Force (and while it is there, nothing is registered).
foreach ($step in $state.steps) { if ($step.ok -eq $true -and $step.skipped -ne $true) { $done[$step.step] = $true } }
if ($Force) { $done = @{}; $state.steps = @() }

function Step([string]$name, [scriptblock]$body, [switch]$Always) {
  # -Always: THE ONE STEP THAT IS NEVER SKIPPED (mcp-relay-reassert). Every other
  # step is idempotent-by-marker - right for installing OpenSSH, wrong for the
  # relay lane, which can be dead (killed, crashed, an onlogon task that never
  # fired) while the marker still reads ok:true from the pass that installed it.
  if (-not $Always -and $done.ContainsKey($name)) { Say "== $name (already done, skipped)"; return }
  Say "== $name"
  # ATTEMPTS, NOT HISTORY. The marker keeps ONE row per step (the state now) plus
  # how many times it has actually EXECUTED, so "was this step tried twice" is a
  # field instead of an inference from duplicate rows. A row written by an older
  # firstboot has no `attempts`, and that reads as 1 - the count restarts here
  # rather than being invented from entries that were never counted.
  $previous = @($state.steps | Where-Object { $_.step -eq $name } | Select-Object -Last 1)
  $attempts = 1
  if ($previous.Count -gt 0 -and $previous[0].attempts) { $attempts = ([int]$previous[0].attempts) + 1 }
  # A FAILING STEP MAY ALSO CARRY A FIELD, NOT ONLY A SENTENCE (R9/C14). The
  # desktop-token probe has to leave `desktopProbe:'failed:<why>'` in the SAME row
  # that carries ok:false - a reader QUERIES the field, while a thrown sentence
  # only reaches the log. A step sets $script:pendingStepAnnotation just before it
  # throws; clearing it here is what stops one failure inheriting another one's
  # annotation.
  $script:pendingStepAnnotation = $null
  try {
    $result = & $body
    $entry = @{ step = $name; ok = $true; attempts = $attempts }
    # A BODY MAY ANNOTATE ITS OWN MARKER ENTRY by returning a hashtable. The
    # clip-agent step uses it to record `skipped = $true; reason =
    # 'clip-agent-disabled'` when the privacy off-switch sentinel exists: a bare
    # ok:true there would read as "the task was registered", which is the exact
    # lie the switch exists to prevent. The relay steps use the same mechanism for
    # "registered, but this pass cannot own an interactive session".
    #
    # SEARCHED, NOT TESTED ON $result: a body that logged with Say before
    # returning its hashtable hands back an ARRAY of strings and hashtables, and
    # `$result -is [hashtable]` would be false - the skip annotation would vanish
    # into a plain ok:true, which is the defect all over again.
    $annotation = @($result | Where-Object { $_ -is [hashtable] } | Select-Object -First 1)
    if ($annotation.Count -gt 0) {
      foreach ($key in $annotation[0].Keys) { $entry[$key] = $annotation[0][$key] }
    }
  } catch {
    Say "FAILED $name : $($_.Exception.Message)"
    $entry = @{ step = $name; ok = $false; error = $_.Exception.Message; attempts = $attempts }
    if ($script:pendingStepAnnotation) {
      foreach ($key in $script:pendingStepAnnotation.Keys) { $entry[$key] = $script:pendingStepAnnotation[$key] }
    }
  }
  # REPLACE, DO NOT APPEND: two rows for one step made the marker read as a log
  # and left a reader guessing which one was current. @(...) on both sides keeps
  # `steps` an ARRAY even with a single entry - ConvertTo-Json would otherwise
  # serialise it as an OBJECT and every reader of steps[] would break.
  $kept = @($state.steps | Where-Object { $_.step -ne $name })
  $state.steps = @($kept + @($entry))
  $state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
}

# M2: `Get-Command python` on Windows 11 happily returns the WindowsApps
# App Execution Alias - a 0-byte stub that opens the Store instead of running
# Python. Installing "succeeded", pip then failed, and the whole dsh-cua step
# died. Only a real interpreter (outside \WindowsApps) counts.
function Get-RealPython {
  foreach ($candidate in @(Get-Command python -All -ErrorAction SilentlyContinue)) {
    if ($candidate.Source -and $candidate.Source -notmatch '\\WindowsApps\\') { return $candidate.Source }
  }
  return $null
}

# ---------------------------------------------------------------------------
# WP-1: THE PYTHON LANE'S TWO PRIMITIVES - RUN A STATEMENT, AND REPAIR pywin32.
#
# WHY THEY EXIST AT ALL: the only verification this script had for its payload was
# `importlib.util.find_spec('dsh_cua')`, which is a submodule FINDER. It answers
# "is the package directory importable" and never "can its submodules be
# imported", so it cannot see a pywin32 whose DLLs were never copied: the import
# succeeds in the finder's world and dies at tool time with
#
#     ImportError: DLL load failed while importing win32ui
#
# (upstream uia.py:452-463, on the path every element_action* takes through
# _wrapper_for). pywin32 ships win32ui.pyd but keeps pywintypes3??.dll and
# pythoncom3??.dll in pywin32_system32 until `pywin32_postinstall.py -install`
# copies them beside the .pyd files, and `pip install` does not run that when the
# wheel is already satisfied. The functions below are the ASSERTION (`import
# win32ui, win32gui` really executed) and the REPAIR (run the post-install, then
# assert again).
# ---------------------------------------------------------------------------

# ONE STATEMENT, ITS EXIT CODE, AND THE LINE THAT NAMES THE FAILURE. stderr is
# merged into stdout because a Python traceback arrives there, and its LAST line is
# the only one worth putting in the marker ("ImportError: DLL load failed while
# importing win32ui: The specified module could not be found."). `error` is that
# line; `lines` is everything, for a caller that wants a value.
function Invoke-PythonCheck([string]$PythonPath, [string]$Statement) {
  $exit = 1
  $lines = @()
  try {
    $lines = @(& $PythonPath -c $Statement 2>&1)
    $exit = $LASTEXITCODE
  } catch {
    $lines = @($_.Exception.Message)
    $exit = 1
  }
  $text = @($lines | ForEach-Object { [string]$_ })
  $errorLine = ''
  for ($i = $text.Count - 1; $i -ge 0; $i--) {
    $trimmed = $text[$i].Trim()
    if ($trimmed) { $errorLine = $trimmed; break }
  }
  return @{ exit = $exit; lines = $text; error = $errorLine }
}

# THE LAST NON-EMPTY LINE OF A SUCCESSFUL STATEMENT - the shape a `print(...)`
# answer has (a version, a path). '' when the statement failed, and every caller
# reads that as "unknown" rather than as a value.
function Get-PythonValue([string]$PythonPath, [string]$Statement) {
  $check = Invoke-PythonCheck -PythonPath $PythonPath -Statement $Statement
  if ($check.exit -ne 0) { return '' }
  $last = ''
  foreach ($line in @($check.lines)) {
    $trimmed = ([string]$line).Trim()
    if ($trimmed) { $last = $trimmed }
  }
  return $last
}

# WHERE pywin32_postinstall.py IS. Two documented layouts: the wheel drops it in
# <purelib> (site-packages), and a legacy installer put it in the Scripts
# directory beside the interpreter. A layout with neither returns $null, which the
# repair reports instead of failing the step on a path error.
function Find-PyWin32PostInstall([string]$PythonPath) {
  $dirs = @()
  $purelib = Get-PythonValue -PythonPath $PythonPath -Statement "import sysconfig;print(sysconfig.get_paths()['purelib'])"
  if ($purelib) { $dirs += $purelib }
  $pythonDir = Split-Path -Parent $PythonPath
  if ($pythonDir) {
    $dirs += (Join-Path $pythonDir 'Scripts')
    $dirs += $pythonDir
  }
  foreach ($dir in $dirs) {
    if (-not $dir) { continue }
    $candidate = Join-Path $dir 'pywin32_postinstall.py'
    if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) { return $candidate }
  }
  return $null
}

# RUN IT: `-install -silent` first (the documented non-interactive form), then the
# plain `-install` once, because a build that rejects -silent must not leave the
# lane dead over an argument. Returns WHAT RAN and how it exited, so the caller's
# message can say which attempt the DLL error survived.
function Invoke-PyWin32PostInstall([string]$PythonPath) {
  $script = Find-PyWin32PostInstall -PythonPath $PythonPath
  if (-not $script) { return @{ ok = $false; detail = 'pywin32_postinstall.py not found under <purelib> or <Scripts>' } }
  # THE DETAIL IS CUMULATIVE ON PURPOSE: when the retry is what worked, the guest
  # log must say that the `-silent` form was REJECTED, or a reader cannot tell a
  # clean install from a build that needed the fallback - and the marker is the
  # first evidence in every report about this step.
  $detail = ''
  foreach ($extra in @(@('-install', '-silent'), @('-install'))) {
    $exit = 1
    try {
      & $PythonPath $script @extra 2>&1 | Out-Null
      $exit = $LASTEXITCODE
    } catch {
      $exit = -1
    }
    $attempt = "$script $($extra -join ' ') -> exit $exit"
    if (-not $detail) { $detail = $attempt } else { $detail = "$detail; $attempt" }
    if ($exit -eq 0) { return @{ ok = $true; detail = $detail } }
  }
  return @{ ok = $false; detail = $detail }
}

# J22-13: THE ONLY LOCAL PROOF THAT cua-clip-agent IS RUNNING. `schtasks /run`
# exits 0 when Task Scheduler ACCEPTS the request, not when the loop executes -
# and a task whose -File points at nothing "starts" too. The loop publishes
# clip-state*.json as soon as it owns the session and heartbeats it every 30 s,
# so a file stamp taken before the run and re-read afterwards is evidence.
function Get-ClipStateStamps([string]$dir) {
  $map = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter 'clip-state*.json' -File -ErrorAction SilentlyContinue)) {
    $map[$file.FullName] = $file.LastWriteTimeUtc.Ticks
  }
  return $map
}

# THE RELAY PROBE DOES NOT LIVE HERE ANY MORE - AND THAT IS THE FIX.
#
# This file used to carry its own TcpClient probe (Test-RelayPing) and its own
# 20 x 500 ms wait around it. That copy is the one that twice read NINE bytes for
# an EIGHT-byte answer, answered "down" against a healthy relay, and made every
# firstboot run start a SECOND listener whose loser died with WinError 10048.
#
# "Is the relay up" is now answered in exactly one place: cua-relay-guard.ps1,
# which this script calls with -Ensure and the boot task calls with -Boot. The
# wait, the eight-byte assertion and the accumulate loop moved there verbatim, so
# there is one copy of the defect history instead of two that can drift.

# THE ACCOUNT, RESOLVED AND ASSERTED - NEVER %USERNAME%.
#
# `schtasks /create ... /it` WITHOUT `/ru` binds the task to the CALLER, and in the
# SYSTEM pass the caller is the computer account (NAME$): `/it` is meaningless for
# a machine principal and Task Scheduler refuses the create with exit 1. That is
# the reproduced failure (C:\cua-provision.json: mcp-relay-task ok:false "schtasks
# could not register cua-mcp-host (exit 1)" at 12:33:06, ok:true only on the retry
# from the logon pass at 12:35:41).
#
# WHY NOT %USERNAME%: it is the COMPUTER account in the SYSTEM pass, and it is
# merely "whatever happens to be right" in the logon pass - the exact reason the
# defect stayed invisible for so long. The name comes from the guest instead: the
# account the answer file provisions ('cua'), then Winlogon's DefaultUserName (the
# account the automatic logon will use), and every candidate is ASSERTED to be a
# real, enabled local account before it can reach a command line.
function Test-LocalAccount([string]$Name) {
  if (-not $Name) { return $false }
  if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
    $user = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
    if (-not $user) { return $false }
    return [bool]$user.Enabled
  }
  # STRIPPED IMAGES CAN LACK Microsoft.PowerShell.LocalAccounts (the module is
  # part of Windows PowerShell 5.1 on a full install; a reduced image may drop
  # it). `net user <name>` exists on every Windows and its exit code is the
  # assertion - 0 means the account is there.
  try {
    & net.exe user $Name 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Resolve-ProvisionedAccount {
  $candidates = @('cua')
  try {
    $default = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultUserName -ErrorAction Stop).DefaultUserName
    if ($default) { $candidates += [string]$default }
  } catch { }
  foreach ($name in $candidates) {
    if (Test-LocalAccount -Name $name) { return [string]$name }
  }
  # A renamed account is still fixed by asking which local accounts exist: the
  # single enabled non-builtin one is the account Setup created. More than one
  # candidate stays unresolved on purpose - guessing the wrong account would
  # register a task that never runs in the session the harness can see.
  if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
    $local = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -and $_.Name -ne 'Administrator' -and $_.Name -ne 'Guest' })
    if ($local.Count -eq 1) { return [string]$local[0].Name }
  }
  return $null
}

# THE OEM PAYLOAD SEARCH, for the files firstboot stages but does not own. The
# list is the SAME one the relay uses further down: $PSScriptRoot (Setup\Scripts),
# the setup.img ROOT (the removable roots the fallback boot path walks) and a copy
# an operator already put in place. -ErrorAction SilentlyContinue on every probe
# because a drive letter this guest does not have must read as "not there", never
# as "the step failed".
function Find-OemPayloadFile([string]$Name) {
  $dirs = @($PSScriptRoot, 'C:\Windows\Setup\Scripts', 'C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')
  foreach ($dir in $dirs) {
    if (-not $dir) { continue }
    $candidate = Join-Path $dir $Name
    if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) { return $candidate }
  }
  return $null
}

# WHERE THE GUARD IS. ProgramData first (the staged, canonical copy the boot task
# names), then the payload (a firstboot pass that runs before the staging step, or
# a guest whose staged copy was deleted).
function Find-RelayGuardPath {
  $staged = 'C:\ProgramData\cua\cua-relay-guard.ps1'
  if (Test-Path -LiteralPath $staged -ErrorAction SilentlyContinue) { return $staged }
  return (Find-OemPayloadFile -Name 'cua-relay-guard.ps1')
}

# ONE CALL PATH INTO THE GUARD. Windows PowerShell is named BY PATH, not by the
# `powershell` on PATH: firstboot can run from a cmd.exe whose PATH predates the
# OpenSSH/python steps, and the check must not depend on that. The guard prints one
# record line; it is captured and returned so this script's own log carries the
# verdict (the exit code alone cannot say WHY a relay is down).
function Invoke-RelayGuard([string]$GuardPath, [string]$Mode, [int]$Port, [string]$Account, [int]$WaitSeconds) {
  if (@('Ensure', 'Autologon', 'Boot') -notcontains $Mode) { throw "unknown relay-guard mode '$Mode'" }
  # NAMED BY PATH when the system root is known (a firstboot that runs from a
  # cmd.exe whose PATH predates the OpenSSH/python steps must not depend on
  # `powershell` being resolvable); the bare name is the fallback, never a guess.
  $ps = 'powershell.exe'
  if ($env:SystemRoot) {
    $candidate = $env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) { $ps = $candidate }
  }
  $arguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', $GuardPath, ('-' + $Mode), '-Port', [string]$Port, '-WaitSeconds', [string]$WaitSeconds
  )
  if ($Account) { $arguments += @('-User', $Account) }
  $lines = @()
  $code = 1
  try {
    $lines = @(& $ps @arguments)
    $code = $LASTEXITCODE
  } catch {
    $code = -1
  }
  $record = (@($lines | ForEach-Object { [string]$_ }) -join ' ').Trim()
  return @{ exit = $code; record = $record }
}

# WHICH PASS AM I? The SYSTEM pass of setupcomplete.cmd cannot own an interactive
# session, so a relay that is not listening there is EXPECTED - while the same
# answer in the logon pass is a real failure. `IsSystem` is the window's own
# answer and does not touch %USERNAME% (see Resolve-ProvisionedAccount).
function Test-SystemPass {
  try {
    return ([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsSystem
  } catch {
    return $false
  }
}

# The relay port, resolved ONCE for every consumer in this script (the launcher,
# the guard task's -Port, the -Ensure calls). DSH_CUA_MCP_RELAY_PORT is the same
# override the relay itself honours; anything unparsable falls back to 47999
# rather than registering a task that listens somewhere nobody probes.
function Resolve-RelayPort {
  if ($env:DSH_CUA_MCP_RELAY_PORT) {
    $parsedPort = 0
    if ([int]::TryParse($env:DSH_CUA_MCP_RELAY_PORT, [ref]$parsedPort) -and $parsedPort -gt 0 -and $parsedPort -lt 65536) { return $parsedPort }
  }
  return 47999
}

# WP-1A - THE LAUNCHER IS THE SOURCE OF TRUTH ON A RE-ENTRY, AND A PASS MUST NOT
# UNDO A REPAIR. `mcp-relay-task` rewrites `mcp-relay-host.vbs` on every run; the
# harness's repair rewrites the same file with the port it probes. Without a read
# here, the next provisioning pass replaces the harness's `--serve --port <n>` with
# this script's env-or-47999 value and the guest re-opens the very split the repair
# closed. The rule below is the guard's `Get-LauncherPort` deliberately: same
# regex, same 1..65535 clamp, same "0 means it does not say" answer, so the guest
# and the boot guard read the one file the same way.
function Get-RelayLauncherPort([string]$LauncherPath) {
  try {
    if (-not $LauncherPath) { return 0 }
    if (-not (Test-Path -LiteralPath $LauncherPath -ErrorAction SilentlyContinue)) { return 0 }
    $content = Get-Content -LiteralPath $LauncherPath -Raw -ErrorAction Stop
    if (-not $content) { return 0 }
    # The port appears in the informational comment line and in the Run line; both
    # carry the same command, and the FIRST `--port <digits>` is the one that runs.
    $match = [regex]::Match([string]$content, '--port\s+([0-9]{1,5})')
    if (-not $match.Success) { return 0 }
    $value = 0
    if (-not [int]::TryParse($match.Groups[1].Value, [ref]$value)) { return 0 }
    if ($value -lt 1 -or $value -gt 65535) { return 0 }
    return $value
  } catch {
    return 0
  }
}

$relayPort = Resolve-RelayPort
$relayAccount = Resolve-ProvisionedAccount
Say "mcp relay: port $relayPort; interactive account '$relayAccount' (resolved from the guest, never %USERNAME%)"

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

# WP-1.3/D2 - ONE DIRECTORY THE DESKTOP TOKEN CAN ACTUALLY WRITE.
#
# THE REPORTED FAILURE IS A PERMISSION DIALOG, NOT A DOCUMENTATION GAP: a save
# path under C:\Users\cua is refused, because the desktop process runs the user's
# FILTERED token at Medium integrity while the profile root it inherits from Setup
# does not grant that token a write (only the High-IL token an SSH login gets can
# write there - see the ORACLE O5 contrast). No sentence in a README fixes that, so
# a dedicated directory is created here with an EXPLICIT DACL and a Medium
# integrity label, and the relay re-proves the write from the desktop token on
# every start (published as desktop.workDirWritable).
#
# WHY THE ACL IS EXPLICIT RATHER THAN INHERITED: an inherited ACE is a promise
# somebody else can revoke. `c:\` hands down whatever the image's profile policy
# says, and the reported guest is exactly the case where that is not a write for
# the filtered token. `/inheritance:r` replaces the inherited list with the three
# grants below and nothing else: SYSTEM and Administrators for repair, `cua` for
# the desktop - each with (OI)(CI)F so subdirectories (a screenshot folder) stay
# writable without a second trip.
#
# WHY THE INTEGRITY LABEL: a Medium label with the default no-write-up policy is
# what makes the directory writable by the desktop's filtered token AND keeps a
# High-IL process from being the only one that can write. `(OI)(CI)M` propagates
# Medium to new children, so a file a tool writes does not inherit a label that
# would then refuse the next write.
#
# WHAT IS FATAL HERE AND WHAT IS NOT: only "the directory could not be created"
# throws. An icacls failure is RECORDED (aclExit/ilExit in the marker) and left to
# the relay's desktop-token measurement, because a guest whose ACL did not take is
# a guest that must SAY SO, not one that must be removed from service.
Step 'cua-workdir' {
  $workDir = 'C:\cua-work'
  $createError = ''
  try {
    New-Item -ItemType Directory -Force -Path $workDir -ErrorAction Stop | Out-Null
  } catch {
    $createError = $_.Exception.Message
  }
  if (-not (Test-Path -LiteralPath $workDir -ErrorAction SilentlyContinue)) {
    throw "could not create $workDir ($createError)"
  }

  # `/grant` takes one principal per argument; the machine-qualified `cua` account
  # is built as ONE token so the colon that introduces the rights list cannot be
  # read as a variable qualifier.
  $cuaGrant = "$($env:COMPUTERNAME)\cua:(OI)(CI)F"
  $aclExit = 1
  $aclDetail = ''
  try {
    $aclOut = @(& icacls.exe $workDir /inheritance:r /grant 'SYSTEM:(OI)(CI)F' /grant 'Administrators:(OI)(CI)F' /grant $cuaGrant 2>&1)
    $aclExit = $LASTEXITCODE
    $aclDetail = ((@($aclOut | ForEach-Object { [string]$_ })) -join ' ').Trim()
  } catch {
    $aclExit = -1
    $aclDetail = $_.Exception.Message
  }

  # The label is set in its own call: `/setintegritylevel` and `/grant` in one
  # icacls line would make a failure of either indistinguishable from the other,
  # and the marker records them separately.
  $ilExit = 1
  $ilDetail = ''
  try {
    $ilOut = @(& icacls.exe $workDir '/setintegritylevel' '(OI)(CI)M' 2>&1)
    $ilExit = $LASTEXITCODE
    $ilDetail = ((@($ilOut | ForEach-Object { [string]$_ })) -join ' ').Trim()
  } catch {
    $ilExit = -1
    $ilDetail = $_.Exception.Message
  }

  # THE WRITE ASSERTION THIS PASS CAN RUN, AND WHAT IT IS NOT WORTH. This token is
  # SYSTEM in the setup pass and the elevated user in the logon pass, so a success
  # here does NOT prove the desktop's filtered token can write - that proof is the
  # relay's probe (WP-3, desktop.workDirWritable) and this field is only "the
  # directory is not read-only to everything". A failure here is still worth
  # recording: it is the one case where every downstream write would fail.
  $probePath = Join-Path $workDir '.firstboot-write'
  $writeOk = $false
  try {
    Set-Content -Path $probePath -Value 'ok' -Encoding ASCII -ErrorAction Stop
    $writeOk = (Test-Path -LiteralPath $probePath -ErrorAction SilentlyContinue)
  } catch {
    $writeOk = $false
  }
  if (Test-Path -LiteralPath $probePath -ErrorAction SilentlyContinue) {
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
  }

  if ($aclExit -ne 0) { Say "cua-workdir: icacls exited $($aclExit): $aclDetail" }
  if ($ilExit -ne 0) { Say "cua-workdir: setintegritylevel exited $($ilExit): $ilDetail" }
  Say "cua-workdir: $workDir ready (acl=$cuaGrant integrity=M writeProbe=$writeOk)"
  return @{ workDir = 'C:\cua-work'; acl = 'cua:(OI)(CI)F'; integrity = 'M'; aclExit = $aclExit; ilExit = $ilExit; writeProbe = $writeOk }
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

  # WP-1.1 - THE SPEC IS THE BACKEND'S PIN, NOT THIS SCRIPT'S CHOICE.
  # This placeholder is substituted from cua-vm-supervisor.mjs, whose default is
  # `dsh-cua==0.4.1` (WINDOWS_DSH_CUA_DEFAULT). That is deliberately the SAME
  # build the D3 hash gate in the `dsh-cua-scale` step below is proven against: a
  # floating spec would install a wheel whose arithmetic the patch must refuse,
  # and "the fix was not staged" would read as "the fix does not work" - exactly
  # the confusion the marker's scriptSha256 was added to end.
  $spec = '{{DSH_CUA_PIP}}'
  & $py -m pip install --disable-pip-version-check --no-input $spec
  $pipExit = $LASTEXITCODE
  # THE EXIT CODE IS THIS STEP'S RESULT. It used to be discarded, so a resolver
  # failure ran on into the find_spec line and was reported as "dsh-cua did not
  # import" - a false statement about the wheel, and a name for the defect that
  # sends the next reader after the wrong problem (nothing was installed at all).
  if ($pipExit -ne 0) { throw "pip install '$spec' exited $pipExit; the wheel was not installed" }

  # A FINDER IS NOT PROOF, but it is the cheap "is the package there" answer and it
  # keeps the old failure message for the case where pip said 0 and installed
  # nothing. The two assertions below are what the element lane actually needs.
  $mod = & $py -c "import importlib.util,sys; print('yes' if importlib.util.find_spec('dsh_cua') else 'no')"
  if ($mod.Trim() -ne 'yes') { throw 'dsh-cua did not import after pip install' }

  # WP-1.1/D1 - THE LANE IS ASSERTED, AND REPAIRED ONCE BEFORE IT IS ASSERTED
  # AGAIN. This is the difference between "the wheel resolved" and "the element
  # lane works": only an EXECUTED import can observe a pywin32 whose DLLs were
  # never copied out of pywin32_system32.
  $lane = Invoke-PythonCheck -PythonPath $py -Statement 'import win32ui, win32gui'
  if ($lane.exit -ne 0) {
    Say "dsh-cua: the element lane is missing ($($lane.error)); running pywin32_postinstall"
    $repair = Invoke-PyWin32PostInstall -PythonPath $py
    Say "dsh-cua: pywin32_postinstall: $($repair.detail)"
    $lane = Invoke-PythonCheck -PythonPath $py -Statement 'import win32ui, win32gui'
  }
  if ($lane.exit -ne 0) {
    # THROWING IS THE RETRY MECHANISM, NOT A GIVE-UP: `$done` only ever holds
    # ok:true, so the next firstboot pass (the logon one, running as `cua`) runs
    # this step again, and the marker's ok:false plus this message is the audit.
    # Recording ok:true here would make a dead lane PERMANENT and invisible - the
    # defect this package closes.
    throw "the element lane is dead: import win32ui failed after pywin32_postinstall ($($lane.error))"
  }

  # WP-1.2 - THE PATTERN PATH IMPORTS ONE MODULE MORE. element_action* goes
  # _wrapper_for -> pywinauto.controls.uiawrapper -> base_wrapper -> win32ui, so
  # win32ui alone does not prove that chain is importable; the module the failure
  # was actually observed in is imported too.
  $uia = Invoke-PythonCheck -PythonPath $py -Statement "import pywinauto.controls.uiawrapper; print('UIA_OK')"
  if ($uia.exit -ne 0) {
    throw "the element lane is dead: import pywinauto.controls.uiawrapper failed ($($uia.error))"
  }

  # WP-1.2 - WHAT IS ACTUALLY INSTALLED, MEASURED. Returned as a hashtable so the
  # Step helper merges it into the `dsh-cua` row (see the annotation handling at
  # the top of this file): dshCua, pywin32 and uiaLane are FIELDS, not a log line
  # a reader has to parse out of prose.
  $dshCuaVersion = Get-PythonValue -PythonPath $py -Statement "import importlib.metadata as m;print(m.version('dsh-cua'))"
  $pywin32Version = Get-PythonValue -PythonPath $py -Statement "import importlib.metadata as m;print(m.version('pywin32'))"
  Say "dsh-cua: element lane OK (pywin32 $pywin32Version, dsh-cua $dshCuaVersion)"
  return @{ dshCua = $dshCuaVersion; pywin32 = $pywin32Version; uiaLane = $true }
}

# THE FUNCTIONAL PROBE FOR THE SCALE ARITHMETIC - NO WINDOW, NO DESKTOP, NO
# SESSION. Appendix A of the SOL fixes its shape: 64x48 of BGRA, a client-area
# crop of (8,8,56,40) -> a 48x32 image, no downscale.
#
# WHAT IT PROVES: the UNPATCHED function divides the WINDOW (64/48 = 1.333333 and
# 48/32 = 1.5) while `scale` stays 1.0 - three numbers that cannot all be right.
# The patched one divides the IMAGE's own size (48/48, 32/32) and answers 1.0/1.0.
#
# Returns 'SCALE_OK', 'SCALE_BAD:<payload>' or 'unverified:<why>'. It NEVER throws:
# a probe that cannot run is a fact to record, not a step to fail.
function Invoke-ScaleProbe([string]$PythonPath) {
  $statement = "import dsh_cua.bridge as b; d,s = b._pixels_to_image_bytes(bytes(64*48*4), 64, 48, (8, 8, 56, 40), image_format='jpeg', quality=80, max_dim=0); ok = (s['width'], s['height']) == (48, 32) and s['scale'] == s['scale_x'] == s['scale_y'] == 1.0; print('SCALE_OK' if ok else 'SCALE_BAD', s)"
  $check = Invoke-PythonCheck -PythonPath $PythonPath -Statement $statement
  if ($check.exit -ne 0) { return "unverified:$($check.error)" }
  $line = ''
  foreach ($text in @($check.lines)) {
    $trimmed = ([string]$text).Trim()
    if ($trimmed) { $line = $trimmed }
  }
  if ($line -like 'SCALE_OK*') { return 'SCALE_OK' }
  if ($line -like 'SCALE_BAD*') { return ('SCALE_BAD:' + $line.Substring('SCALE_BAD'.Length).Trim()) }
  return 'unverified:unexpected-probe-output'
}

# A PROBE WHOSE TEST IS A PROGRAM, NOT A ONE-LINER: write it to a file, run it,
# read the last non-empty line, delete it. `-c` is ONE command line that Windows
# re-parses (the clipboard tasks document the same trap for /tr), and the two
# probes below are multi-line on purpose: they construct a fake control, a fake
# %TEMP% directory and a counting `os` shim. A file is the only form that
# survives the quoting without a second escaping language.
function Invoke-PythonProbeFile([string]$PythonPath, [string]$Name, [string]$Program) {
  # The PID is in the name so a second pass (or a human running the same probe)
  # cannot read the first one's file between its write and its delete.
  $path = Join-Path $env:TEMP ("cua-$PID-" + $Name)
  try {
    Set-Content -Path $path -Value $Program -Encoding ASCII -ErrorAction Stop
  } catch {
    return 'unverified:probe-write-failed'
  }
  try {
    $check = Invoke-PythonCheck -PythonPath $PythonPath -Statement "exec(compile(open(r'$path').read(), r'$path', 'exec'))"
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
  if ($check.exit -ne 0) { return "unverified:$($check.error)" }
  $line = ''
  foreach ($text in @($check.lines)) {
    $trimmed = ([string]$text).Trim()
    if ($trimmed) { $line = $trimmed }
  }
  return $line
}

# THE type_text PROBE IS ANSWERED BY THE PATCH'S OWN HELPER (R5/C10). It hands
# `_type_text_delta` the exact pair the defect is about - `hello world` sent,
# `hello worl` landed - and the three shapes a receipt may take, with NO window,
# NO desktop and NO accessibility lane involved. That is the difference between
# "the step ran" and "the code that decides success is the code I shipped": an
# unpatched wheel answers nothing here, and a patch that lost the tail arithmetic
# answers TYPE_TEXT_BAD (with its evidence) instead of the word `applied`.
function Invoke-TypeTextProbe([string]$PythonPath) {
  $program = @'
import dsh_cua.bridge as b
short = b._type_text_delta('', 'hello worl', 'hello world')
exact = b._type_text_delta('', 'hello world', 'hello world')
same = b._type_text_delta('abc', 'abc', 'xyz')
retry = getattr(b, 'TYPE_TEXT_RETRY', None)
ok = (short == ('short-insert', 'd') and exact == ('verified', '')
      and same[0] == 'no-effect' and retry == 2)
print('TYPE_TEXT_OK' if ok else 'TYPE_TEXT_BAD:' + repr((short, exact, same, retry)))
'@
  $line = Invoke-PythonProbeFile -PythonPath $PythonPath -Name 'cua-typetext-probe.py' -Program $program
  if ($line -like 'TYPE_TEXT_OK*') { return 'TYPE_TEXT_OK' }
  if ($line -like 'TYPE_TEXT_BAD*') { return $line }
  if ($line -like 'unverified:*') { return $line }
  return 'unverified:unexpected-probe-output'
}

# THE save_path PROBE (R7/C11), same shape. It asserts the two HALVES of the
# allow-list in one run: a path under %TEMP%\win32_mcp_shots is created (and
# reported as created), a path under neither root is REFUSED, not created, and
# the sentence names both roots. A `makedirs` that ran on the refused path would
# be the silent-redirect defect in a new place, so `os.path.isdir` is checked
# after the refusal, not only the tuple.
function Invoke-SavePathProbe([string]$PythonPath) {
  $program = @'
import os
import shutil
import tempfile
import dsh_cua.server as s
# A FRESH directory per run: a leftover cua-probe from an earlier pass would make
# `created` False and turn the probe into a false failure - which, on the apply
# path, would roll the patch back for no reason.
tag = 'cua-probe-%d' % os.getpid()
root = os.path.join(os.environ.get('TEMP', '.'), 'win32_mcp_shots', tag)
made, where, err = s._ensure_save_dir(os.path.join(root, 'x.jpg'))
allowed = s._is_allowed_save_dir(os.path.join('C:\\cua-work', 'a', 'b.jpg'))
blocked_dir = os.path.join(tempfile.gettempdir(), tag + '-blocked')
blocked, _where, why = s._ensure_save_dir(os.path.join(blocked_dir, 'x.jpg'))
ok = (made is True and bool(where) and not err and allowed is True
      and blocked is False and 'C:\\cua-work' in why and '%TEMP%' in why
      and not os.path.isdir(blocked_dir))
shutil.rmtree(root, ignore_errors=True)
print('SAVE_PATH_OK' if ok else 'SAVE_PATH_BAD:' + repr((made, where, err, allowed, blocked, why)))
'@
  $line = Invoke-PythonProbeFile -PythonPath $PythonPath -Name 'cua-savepath-probe.py' -Program $program
  if ($line -like 'SAVE_PATH_OK*') { return 'SAVE_PATH_OK' }
  if ($line -like 'SAVE_PATH_BAD*') { return $line }
  if ($line -like 'unverified:*') { return $line }
  return 'unverified:unexpected-probe-output'
}

# A STALE .pyc WOULD KEEP THE OLD CODE RUNNING: the interpreter's cache key is the
# source's mtime and size, and this patch can land inside the same second with the
# same size class. So the cache is dropped BEFORE the re-import, and again after any
# rollback (an attempt that failed to import has already written a cache entry for
# the patched source).
function Clear-BridgePyc([string]$BridgePath, [string]$Filter = 'bridge.*.pyc') {
  if (-not $BridgePath) { return }
  $cacheDir = Join-Path (Split-Path -Parent $BridgePath) '__pycache__'
  # THE FILTER IS A PARAMETER because there are now TWO patched modules: the
  # scale patch owns bridge.py, and R5/R7 own bridge.py and server.py as well.
  # The reason the cache is dropped at all is unchanged: the interpreter's cache
  # key is the source's mtime and size, and an in-place patch can land inside the
  # same second with the same size class, so a stale <module>.*.pyc would keep
  # the OLD code running while the file on disk reads patched.
  Get-ChildItem -LiteralPath $cacheDir -Filter $Filter -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

# PUT THE ORIGINAL BYTES BACK - AND SAY WHETHER IT WORKED.
#
# EVERY refusal that happens after the first byte of the patched file could have
# been written goes through here, THE WRITE ITSELF INCLUDED:
# [System.IO.File]::WriteAllText opens the file with Create (truncate) before it
# writes a byte, so a throw in the middle - a full disk, an AV lock, a sandbox
# denial - can leave bridge.py EMPTY or half-written. The bytes read at the top of
# the step are the only copy, so the caller restores from them and reports the
# MEASURED outcome.
#
# WHY THIS RETURNS A BOOLEAN INSTEAD OF JUST DOING IT: "reverted" is a claim about
# the guest, and a restore that is claimed but not measured is the same class of
# lie as a patch that is claimed but not applied. The caller records this value as
# `restoreOk` in the marker row and never says "reverted" without it.
function Restore-BridgeSource([string]$BridgePath, [byte[]]$OriginalBytes, [string]$ExpectedHash = '', [string]$Filter = 'bridge.*.pyc') {
  if (-not $BridgePath) { return $false }
  if ($null -eq $OriginalBytes) { return $false }
  if ($OriginalBytes.Length -eq 0) { return $false }
  try {
    [System.IO.File]::WriteAllBytes($BridgePath, $OriginalBytes)
  } catch {
    return $false
  }
  # A restored source with a cache entry for the PATCHED source is still a guest
  # running the wrong code, so the cache goes too - and a cache that cannot be
  # cleared means the restore did not do its job.
  # JD2 - THE CACHE THAT MATTERS IS THE ONE FOR *THIS* FILE. The filter used to be
  # hardcoded to `bridge.*.pyc`, so a `dsh-cua-savepath` rollback restored
  # server.py, left a patched `server.*.pyc` alive, and still answered
  # `restoreOk:true` - a guest running the restored-patched mix the rollback
  # existed to prevent. Both the clearing and the liveness check use the same
  # filter now, and the caller names it.
  Clear-BridgePyc -BridgePath $BridgePath -Filter $Filter
  $cacheDir = Join-Path (Split-Path -Parent $BridgePath) '__pycache__'
  if (@(Get-ChildItem -LiteralPath $cacheDir -Filter $Filter -File -ErrorAction SilentlyContinue).Count -gt 0) { return $false }
  if (-not $ExpectedHash) { return $true }
  # BYTES, NOT INTENT: the file on disk is compared with the hash the gate measured
  # before the patch, so a partial write can never be reported as a restore.
  try {
    return ((Get-FileHash -LiteralPath $BridgePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedHash)
  } catch {
    return $false
  }
}

# WP-1.4/D3 - THE SCALE ARITHMETIC, CORRECTED UNDER A GATE AND PROVEN BY A PROBE.
#
# THE DEFECT (upstream bridge.py:474-489): `_pixels_to_image_bytes` receives the
# RAW WINDOW dimensions (w2, h2) and the client-area crop, crops the image, and
# then computes `scale_x = w2/ew`, `scale_y = h2/eh`. With a 640x480 window whose
# client area is 624x441 that reports 1.025641 / 1.088435 beside `scale: 1.0` - the
# three numbers the report found. Nothing was resized: the denominator is simply
# the wrong rectangle. The correct base is the image's own size AFTER the crop (the
# same rectangle `capture_window` already returns as `bounds`), which is what the
# two literal replacements below install.
#
# WHY A HASH-GATED IN-PLACE PATCH AND NOT A WRAPPER OR A PROFILE LAYER: there is no
# DSH profile loader row inside the guest to patch (the relay spawns
# `python -m dsh_cua.server` itself), and the relay's `child_argv()` splits the
# server command with a plain `.split()`, so a wrapper cannot carry a quoted
# `-c "..."` program without moving the spawn path. Three literal edits in a file
# whose version AND SHA-256 are pinned - refusing on any mismatch - is the smaller
# and LOUDER change: a refusal is a sentence the doctor repeats.
#
# NEVER THROWS. Every refusal is a recorded fact (`scaleFix:'skipped:<why>'`),
# because a patch that silently did not apply is worse than one that says so. A
# refusal that had to UNDO a write also records `restoreOk` - the measured result of
# the rollback - and the log says "reverted" only when that value is true.
Step 'dsh-cua-scale' {
  $expectedVersion = '0.4.1'
  $expectedHash = '59280ee9079cc09aa94b3813fd7a7665cfebffe68fb7259b752e161abf1f9209'
  # JD1 - THE SECOND ACCEPTED BASE. bridge.py is patched by TWO steps (this one and
  # `dsh-cua-typetext`), so a gate on the pristine bytes ALONE locks the second one
  # out forever: whichever step runs second would answer `skipped:hash-mismatch` on
  # every boot. This is the hash of the same wheel with the typetext patch already
  # applied - accepted here, and the mirror image is accepted there. The two edits
  # touch DISJOINT text, so applying this step's anchors on either base composes to
  # the same bytes in either order (asserted by tests/guest-patch.mjs D-21).
  $expectedHashTypeText = '01b55a637f3ec8fe2be085345d675c6ca31aed7b8b34397e848c653792b489a3'

  $py = Get-RealPython
  if (-not $py) {
    Say 'dsh-cua-scale: skipped (no python interpreter)'
    return @{ scaleFix = 'skipped:no-python'; scaleHash = ''; scaleProbe = 'unverified:no-python' }
  }

  # WHERE THE FILE IS, WITHOUT IMPORTING IT. `find_spec` resolves the origin path
  # and executes nothing - bridge.py imports `windll` at module level, so importing
  # it just to learn its filename would make this step depend on the lane it is
  # meant to help.
  $bridgePath = Get-PythonValue -PythonPath $py -Statement "import importlib.util;print(importlib.util.find_spec('dsh_cua.bridge').origin)"
  if (-not $bridgePath -or -not (Test-Path -LiteralPath $bridgePath -ErrorAction SilentlyContinue)) {
    Say "dsh-cua-scale: skipped (bridge.py not found: '$bridgePath')"
    return @{ scaleFix = 'skipped:no-file'; scaleHash = ''; scaleProbe = 'unverified:no-file' }
  }

  $measureHash = ''
  try { $measureHash = (Get-FileHash -LiteralPath $bridgePath -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $measureHash = '' }

  # GATE 1 - THE VERSION. The arithmetic below is proven against this build only.
  # `dsh-cua==0.4.1` is the backend's default spec, so a guest that got a
  # different wheel is a guest whose patch would be guessed rather than verified.
  $dshCuaVersion = Get-PythonValue -PythonPath $py -Statement "import importlib.metadata as m;print(m.version('dsh-cua'))"
  if ($dshCuaVersion -ne $expectedVersion) {
    Say "dsh-cua-scale: skipped (dsh-cua '$dshCuaVersion' is not the pinned '$expectedVersion')"
    return @{ scaleFix = 'skipped:version-mismatch'; scaleHash = $measureHash; scaleProbe = 'unverified:version-mismatch' }
  }

  # CRLF -> LF BEFORE ANY MATCHING OR WRITING. The wheel may ship either ending and
  # the anchors below are written once, in LF; the write below is LF too, so a
  # patched file is one consistent shape instead of a mixed one.
  $originalBytes = $null
  $text = ''
  try {
    $originalBytes = [System.IO.File]::ReadAllBytes($bridgePath)
    $text = [System.Text.Encoding]::UTF8.GetString($originalBytes).Replace("`r`n", "`n")
  } catch {
    Say "dsh-cua-scale: skipped (bridge.py unreadable: $($_.Exception.Message))"
    return @{ scaleFix = 'skipped:no-file'; scaleHash = $measureHash; scaleProbe = 'unverified:unreadable' }
  }

  # ALREADY PATCHED IS A POSITIVE STATE, AND IT IS CHECKED BEFORE THE HASH GATE:
  # the patch changes the file, so a second run can never hash-match the pinned
  # value. This is gate 4 of Appendix A moved first, because it is the only order in
  # which idempotence (A6: a second -Force run reports `already` and does not insert
  # a second `base_w`) can be true at all.
  if ($text.Contains('base_w, base_h = img.size')) {
    $alreadyProbe = Invoke-ScaleProbe -PythonPath $py
    Say "dsh-cua-scale: already patched (probe $alreadyProbe)"
    return @{ scaleFix = 'already'; scaleHash = $measureHash; scaleProbe = $alreadyProbe }
  }

  # GATE 2 - THE HASH OF A BASE THIS WAS PROVEN AGAINST: the PRISTINE wheel, or the
  # same wheel with the typetext patch in it (JD1). The normal order puts this step
  # first (S6), but the order must not be the thing that decides whether a patch
  # lands - the anchor counts do.
  $scaleBase = ''
  if ($measureHash -eq $expectedHash) { $scaleBase = 'pristine' }
  elseif ($measureHash -eq $expectedHashTypeText) { $scaleBase = 'typetext-patched' }
  if (-not $scaleBase) {
    Say "dsh-cua-scale: skipped (sha256 $measureHash is neither the pristine $expectedHash nor the typetext-patched $expectedHashTypeText)"
    return @{ scaleFix = 'skipped:hash-mismatch'; scaleHash = $measureHash; scaleProbe = 'unverified:hash-mismatch' }
  }
  # A HASH IDENTIFIES BYTES, NOT AN EDIT: the accepted non-pristine base must carry
  # the typetext sentinel, or the number matched something this step was never
  # proven against and the anchors below would be the only thing between it and a
  # guessed write.
  if ($scaleBase -eq 'typetext-patched' -and -not $text.Contains('if expected is not None:')) {
    Say 'dsh-cua-scale: skipped (the typetext-patched hash matched but its sentinel is absent; not applying to bytes nobody verified)'
    return @{ scaleFix = 'skipped:hash-mismatch'; scaleHash = $measureHash; scaleProbe = 'unverified:hash-mismatch' }
  }

  # GATE 3 - BOTH ANCHORS, EXACTLY ONCE. `count == 1` on each is what makes a
  # literal replacement safe: zero means the wheel drifted, more than one means the
  # replacement would land in a place nobody verified.
  $anchorA = @'
    if crop is not None:
        img = img.crop(crop)
    scale = 1.0
'@
  $replacementA = @'
    if crop is not None:
        img = img.crop(crop)
    # [cua-D3] the rectangle this image covers, AFTER the client-area crop and
    # BEFORE any downscale. scale_x/scale_y must be measured against this, not
    # against the full window the raw BGRA buffer was taken from.
    base_w, base_h = img.size
    scale = 1.0
'@
  $anchorB = @'
              "scale_x": round(w2 / ew, 6) if ew else 1.0,
              "scale_y": round(h2 / eh, 6) if eh else 1.0,
'@
  $replacementB = @'
              "scale_x": round(base_w / ew, 6) if ew else 1.0,
              "scale_y": round(base_h / eh, 6) if eh else 1.0,
'@
  # A file edited on a Windows host can carry CRLF inside the here-strings; the
  # text they are matched against was normalised above, so they are normalised too.
  $anchorA = $anchorA.Replace("`r`n", "`n")
  $replacementA = $replacementA.Replace("`r`n", "`n")
  $anchorB = $anchorB.Replace("`r`n", "`n")
  $replacementB = $replacementB.Replace("`r`n", "`n")

  $anchorACount = ([regex]::Matches($text, [regex]::Escape($anchorA))).Count
  $anchorBCount = ([regex]::Matches($text, [regex]::Escape($anchorB))).Count
  if ($anchorACount -eq 0 -or $anchorBCount -eq 0) {
    Say "dsh-cua-scale: skipped (anchor missing: A=$anchorACount B=$anchorBCount)"
    return @{ scaleFix = 'skipped:anchor-missing'; scaleHash = $measureHash; scaleProbe = 'unverified:anchor-missing' }
  }
  if ($anchorACount -ne 1 -or $anchorBCount -ne 1) {
    Say "dsh-cua-scale: skipped (anchor ambiguous: A=$anchorACount B=$anchorBCount)"
    return @{ scaleFix = 'skipped:anchor-ambiguous'; scaleHash = $measureHash; scaleProbe = 'unverified:anchor-ambiguous' }
  }

  $patched = $text.Replace($anchorA, $replacementA).Replace($anchorB, $replacementB)
  if (($patched -eq $text) -or (-not $patched.Contains('base_w, base_h = img.size'))) {
    Say 'dsh-cua-scale: skipped (the two replacements produced no change)'
    return @{ scaleFix = 'skipped:anchor-missing'; scaleHash = $measureHash; scaleProbe = 'unverified:no-change' }
  }

  $writeError = ''
  $restoreOk = $true
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($bridgePath, $patched, $utf8NoBom)
  } catch {
    $writeError = $_.Exception.Message
    # THE WRITE MAY ALREADY HAVE TRUNCATED THE FILE (Create runs before the first
    # byte). Nothing may be reported as "skipped, nothing happened" until the
    # original bytes are MEASURED back in place.
    $restoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
  }
  if ($writeError) {
    if ($restoreOk) {
      Say "dsh-cua-scale: skipped (bridge.py not writable: $writeError; the original bytes are back in place)"
    } else {
      Say "dsh-cua-scale: NOT RESTORED (bridge.py was not writable: $writeError, and the rollback failed too) - $bridgePath may be truncated or partly written; reinstall dsh-cua==$expectedVersion"
    }
    return @{ scaleFix = 'skipped:write-failed'; scaleHash = $measureHash; scaleProbe = 'unverified:write-failed'; restoreOk = $restoreOk }
  }

  Clear-BridgePyc -BridgePath $bridgePath

  # THE PATCH IS NOT CALLED `applied` UNTIL THE MODULES STILL IMPORT. A bridge.py
  # that no longer loads is worse than an unpatched one, so the original bytes (in
  # hand since the read above) go back and the refusal is recorded.
  $importCheck = Invoke-PythonCheck -PythonPath $py -Statement "import dsh_cua.bridge, dsh_cua.server; print('IMPORT_OK')"
  if ($importCheck.exit -ne 0) {
    $restoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
    if ($restoreOk) {
      Say "dsh-cua-scale: import failed after the patch, reverted ($($importCheck.error))"
    } else {
      Say "dsh-cua-scale: NOT RESTORED after a failed import ($($importCheck.error)) - $bridgePath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ scaleFix = 'skipped:import-failed'; scaleHash = $measureHash; scaleProbe = 'unverified:import-failed'; restoreOk = $restoreOk }
  }

  # THE SECOND CHECK IS THE ARITHMETIC ITSELF, which is the whole point of the
  # change. `SCALE_BAD` here means the numbers are still wrong, so the patch is
  # rolled back and reported; `unverified:` means the probe could not run, and the
  # patch stays with that fact recorded rather than being called a success.
  $scaleProbe = Invoke-ScaleProbe -PythonPath $py
  if ($scaleProbe -like 'SCALE_BAD*') {
    $restoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
    if ($restoreOk) {
      Say "dsh-cua-scale: probe says $scaleProbe after the patch, reverted"
    } else {
      Say "dsh-cua-scale: NOT RESTORED after a bad probe ($scaleProbe) - $bridgePath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ scaleFix = 'skipped:probe-failed'; scaleHash = $measureHash; scaleProbe = $scaleProbe; restoreOk = $restoreOk }
  }

  Say "dsh-cua-scale: applied on the $scaleBase base + $scaleProbe"
  return @{ scaleFix = 'applied'; scaleHash = $measureHash; scaleProbe = $scaleProbe; scaleBase = $scaleBase }
}

# R5/C10 - THE EXACT-INSERT RECEIPT, INSTALLED IN PLACE UNDER A HASH GATE.
#
# THE DEFECT (upstream bridge.py:974-976): `effect_verified = after != before`.
# `hello world` sent and `hello worl` landing is a CHANGED control, so the receipt
# read `verified` and `ok` stayed true while one character was lost. Character
# loss is data loss inside the only input path left when the element lane is dead
# (R4 + R5 compound: the guest loses the lane, falls back to injection, and the
# injection lies), and it is what made the reported save step retype into a
# dialog with the wrong text in it.
#
# WHY A PATCH AND NOT A WRAPPER: the relay spawns `python -m dsh_cua.server`
# itself (child_argv() splits a plain string, so a quoted `-c` program cannot ride
# along), and the caller that must see `missing` is the tool call, which reaches
# type_text through the wheel's own `mcp.tool` registration. Same discipline as
# `dsh-cua-scale`: pinned version, pinned SHA-256, every anchor counted, and the
# word `applied` only after a probe the PATCH answers.
#
# NEVER THROWS. A refusal is a recorded fact (`typeTextFix:'skipped:<why>'`), and
# a refusal that had to undo a write records the MEASURED rollback (`restoreOk`).
Step 'dsh-cua-typetext' {
  $expectedVersion = '0.4.1'
  $expectedHash = '59280ee9079cc09aa94b3813fd7a7665cfebffe68fb7259b752e161abf1f9209'
  # JD1 - THE SECOND ACCEPTED BASE, and this one is the NORMAL case: S6 runs
  # `dsh-cua-scale` first, so by the time this step reads bridge.py the file is
  # already scale-patched and hashes to this value. Gating on the pristine bytes
  # alone is the reported defect: scale applied, then this step answered
  # `skipped:hash-mismatch` on every boot and the R5 fix never landed. The mirror
  # pin (`$expectedHashTypeText` in the scale step) makes the pair order-proof.
  $expectedHashScaled = 'd7c3f06dc807d965ee9b7ddb7b9018a3889674e7530969ecaa83cf928aa7c020'
  # THE IDEMPOTENCE SENTINEL. It exists in the PATCHED file and nowhere in the
  # pinned one, and it is checked BEFORE the hash gate: the patch changes the
  # bytes, so a second -Force pass can never hash-match the pinned value. That
  # order is the only one in which "run it twice" is a no-op instead of a second
  # copy of the block (which no hash gate could catch).
  $sentinel = 'if expected is not None:'

  $py = Get-RealPython
  if (-not $py) {
    Say 'dsh-cua-typetext: skipped (no python interpreter)'
    return @{ typeTextFix = 'skipped:no-python'; typeTextHash = ''; typeTextProbe = 'unverified:no-python' }
  }

  $bridgePath = Get-PythonValue -PythonPath $py -Statement "import importlib.util;print(importlib.util.find_spec('dsh_cua.bridge').origin)"
  if (-not $bridgePath -or -not (Test-Path -LiteralPath $bridgePath -ErrorAction SilentlyContinue)) {
    Say "dsh-cua-typetext: skipped (bridge.py not found: '$bridgePath')"
    return @{ typeTextFix = 'skipped:no-file'; typeTextHash = ''; typeTextProbe = 'unverified:no-file' }
  }

  $measureHash = ''
  try { $measureHash = (Get-FileHash -LiteralPath $bridgePath -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $measureHash = '' }

  $dshCuaVersion = Get-PythonValue -PythonPath $py -Statement "import importlib.metadata as m;print(m.version('dsh-cua'))"
  if ($dshCuaVersion -ne $expectedVersion) {
    Say "dsh-cua-typetext: skipped (dsh-cua '$dshCuaVersion' is not the pinned '$expectedVersion')"
    return @{ typeTextFix = 'skipped:version-mismatch'; typeTextHash = $measureHash; typeTextProbe = 'unverified:version-mismatch' }
  }

  # CRLF -> LF BEFORE MATCHING OR WRITING, exactly like the scale step: the wheel
  # may ship either ending and the anchors below are written once, in LF.
  $originalBytes = $null
  $text = ''
  try {
    $originalBytes = [System.IO.File]::ReadAllBytes($bridgePath)
    $text = [System.Text.Encoding]::UTF8.GetString($originalBytes).Replace("`r`n", "`n")
  } catch {
    Say "dsh-cua-typetext: skipped (bridge.py unreadable: $($_.Exception.Message))"
    return @{ typeTextFix = 'skipped:no-file'; typeTextHash = $measureHash; typeTextProbe = 'unverified:unreadable' }
  }

  if ($text.Contains($sentinel)) {
    $alreadyProbe = Invoke-TypeTextProbe -PythonPath $py
    Say "dsh-cua-typetext: already patched (probe $alreadyProbe)"
    return @{ typeTextFix = 'already'; typeTextHash = $measureHash; typeTextProbe = $alreadyProbe }
  }

  # GATE 2 - THE HASH OF A BASE THIS WAS PROVEN AGAINST: pristine, or the same
  # wheel with the scale patch already applied (JD1).
  $typeTextBase = ''
  if ($measureHash -eq $expectedHash) { $typeTextBase = 'pristine' }
  elseif ($measureHash -eq $expectedHashScaled) { $typeTextBase = 'scale-patched' }
  if (-not $typeTextBase) {
    Say "dsh-cua-typetext: skipped (sha256 $measureHash is neither the pristine $expectedHash nor the scale-patched $expectedHashScaled)"
    return @{ typeTextFix = 'skipped:hash-mismatch'; typeTextHash = $measureHash; typeTextProbe = 'unverified:hash-mismatch' }
  }
  # The accepted non-pristine base must really be the scale-patched file.
  if ($typeTextBase -eq 'scale-patched' -and -not $text.Contains('base_w, base_h = img.size')) {
    Say 'dsh-cua-typetext: skipped (the scale-patched hash matched but the scale sentinel is absent; not applying to bytes nobody verified)'
    return @{ typeTextFix = 'skipped:hash-mismatch'; typeTextHash = $measureHash; typeTextProbe = 'unverified:hash-mismatch' }
  }

  # THREE ANCHORS, EACH EXACTLY ONCE. The helper goes in at module level (a
  # three-line in-function anchor cannot define one, and the probe has to import
  # it to answer at all), the state machine replaces the three receipt lines, and
  # the out dict gains the retry ink. Zero occurrences means the wheel drifted;
  # two means the replacement would land somewhere nobody verified.
  $anchorTTHelper = @'
def type_text(hwnd: int, text: str, delay: float = 0.01) -> dict:
'@
  $replacementTTHelper = @'
# [cua-D4] THE EXACT-INSERT RECEIPT (R5/C10).
#
# THE DEFECT THIS REPLACES: `effect_verified = after != before` called a
# TRUNCATED insert a success. With `hello world` sent and `hello worl` landing the
# control's text HAD changed, so the receipt said verified and `ok` stayed true
# while one character was silently lost - and this is the only input path left
# when the element lane is dead, so the loss reached the caller as success.
#
# The compare below is EXACT (`after == before + text`), the failure carries the
# TAIL that did not land, and the tail is what the two retries post again.
TYPE_TEXT_RETRY = 2
# WM_SETTEXT is the restore path: a terminal short insert puts the control back to
# what it held BEFORE this call instead of leaving half a sentence in it.
WM_SETTEXT = 0x000C


def _type_text_delta(before, after, text):
    """(state, missing) for one insert attempt. Pure: no Windows call, no state.

    'verified'     after == before + text - EXACT equality is the only success.
    'short-insert' before is a prefix of after and the landed suffix is a strict
                   prefix of text, so `missing` is the tail that never arrived.
    'no-effect'    after == before: nothing landed at all.
    'unaccounted'  the text changed in a way this receipt cannot attribute to this
                   insertion (a selection replaced, a maximum length reached
                   mid-string, or somebody else typing).
    'unknown'      a read-back was not possible: the effect is UNCONFIRMED, which
                   is not the same as failed.
    """
    if before is None or after is None:
        return ("unknown", "")
    if after == before + text:
        return ("verified", "")
    if after == before:
        return ("no-effect", text)
    if after.startswith(before):
        landed = after[len(before):]
        if text.startswith(landed) and landed != text:
            return ("short-insert", text[len(landed):])
    return ("unaccounted", "")


def _type_text_restore(dest, before):
    """Put the control's text back to `before`, and MEASURE whether it landed.

    What it can and cannot do, said plainly: WM_SETTEXT replaces the whole text in
    one message, so a control that lost the tail of an insert gets its ORIGINAL
    value back. A control this process cannot write (read-only, or a class that
    ignores WM_SETTEXT) answers False instead, and the caller reports that rather
    than claiming a clean revert. The verdict is the re-read, never the send.
    """
    if before is None:
        return False
    try:
        buf = ctypes.create_unicode_buffer(str(before))
        res = ctypes.c_size_t(0)
        user32.SendMessageTimeoutW(w.HWND(dest), WM_SETTEXT, 0,
                                   ctypes.cast(buf, ctypes.c_void_p).value,
                                   SMTO_ABORTIFHUNG, _SEND_TIMEOUT_MS, byref(res))
    except Exception:
        return False
    return _read_control_text(dest) == before


def type_text(hwnd: int, text: str, delay: float = 0.01) -> dict:
'@
  $anchorTT = @'
        effect_verified = None
        if before is not None and after is not None:
            effect_verified = after != before
'@
  $replacementTT = @'
        # [cua-D4] C10 - EXACT COMPARE, THE MISSING TAIL, AND TWO RETRIES.
        #
        # `expected` is the only thing this call may call success. `missing` is the
        # tail that did not land, and each extra attempt posts ONLY that tail:
        # retyping the whole string would duplicate the part that did arrive.
        # `restoreOk` is the MEASURED result of putting the control back and is
        # absent when there was no control to put back (no read-back target).
        expected = ((before or "") + text) if before is not None else None
        state, missing = ("unknown", "")
        if expected is not None:
            state, missing = _type_text_delta(before, after, text)
        retries = 0
        recovered = False
        while state == "short-insert" and retries < TYPE_TEXT_RETRY:
            retries += 1
            for ch in missing:
                user32.PostMessageW(w.HWND(dest), WM_CHAR, ord(ch), 0)
                if delay > 0: time.sleep(delay)
            after = _read_control_text(dest)
            if after is None:
                state, missing = ("unknown", "")
                break
            state, missing = _type_text_delta(before, after, text)
            recovered = state == "verified"
        if state == "verified":
            effect_verified = True
        elif state == "unknown":
            effect_verified = None
        else:
            effect_verified = False
        if state == "short-insert" or state == "unaccounted":
            # TERMINAL FAILURE: say what is missing, put the control back, and do
            # NOT return a success receipt. `retries` is how many attempts ran, not
            # how many were allowed.
            restore_ok = None
            if target is not None:
                restore_ok = _type_text_restore(dest, before)
            failed = {"ok": False, "reason": state, "hwnd": hwnd, "target_hwnd": dest,
                      "resolved_by": resolved_by or None,
                      "typed": len(text), "text_length": len(text),
                      "effect_verified": False,
                      "retries": retries, "recovered": False, "missing": missing,
                      "foreground_changed": foreground_root() != fg_before,
                      "raise": raise_info, "arbiter": arbiter.receipt(gate),
                      "before": (before or "")[:80], "after": (after or "")[:80]}
            if restore_ok is not None:
                failed["restoreOk"] = restore_ok
            if state == "short-insert":
                failed["error"] = (
                    "the control kept %d of the %d character(s) sent; %r did not land "
                    "after %d retry attempt(s), so the effect is NOT verified"
                    % (len(text) - len(missing), len(text), missing, retries))
            else:
                failed["error"] = (
                    "the control's text changed, but not by this insertion (before=%r "
                    "after=%r): no tail could be identified to retry, so the effect is "
                    "NOT verified" % ((before or "")[:60], (after or "")[:60]))
            return failed
'@
  $anchorTTReceipt = @'
        out = {"ok": True, "reason": "typed", "hwnd": hwnd, "target_hwnd": dest,
               "resolved_by": resolved_by or None,
               "typed": len(text), "text_length": len(text),
               "effect_verified": effect_verified,
'@
  $replacementTTReceipt = @'
        out = {"ok": True, "reason": "typed", "hwnd": hwnd, "target_hwnd": dest,
               "resolved_by": resolved_by or None,
               "typed": len(text), "text_length": len(text),
               "effect_verified": effect_verified,
               # [cua-D4] C10: the retry ink is on EVERY receipt - 0 / False / ''
               # when the first attempt was exact, the tail and the count when it
               # was not.
               "retries": retries, "recovered": bool(recovered),
               "missing": "" if effect_verified else missing,
'@
  $anchorTTHelper = $anchorTTHelper.Replace("`r`n", "`n")
  $replacementTTHelper = $replacementTTHelper.Replace("`r`n", "`n")
  $anchorTT = $anchorTT.Replace("`r`n", "`n")
  $replacementTT = $replacementTT.Replace("`r`n", "`n")
  $anchorTTReceipt = $anchorTTReceipt.Replace("`r`n", "`n")
  $replacementTTReceipt = $replacementTTReceipt.Replace("`r`n", "`n")

  $countTTHelper = ([regex]::Matches($text, [regex]::Escape($anchorTTHelper))).Count
  $countTT = ([regex]::Matches($text, [regex]::Escape($anchorTT))).Count
  $countTTReceipt = ([regex]::Matches($text, [regex]::Escape($anchorTTReceipt))).Count
  if ($countTTHelper -eq 0 -or $countTT -eq 0 -or $countTTReceipt -eq 0) {
    Say "dsh-cua-typetext: skipped (anchor missing: helper=$countTTHelper effect=$countTT receipt=$countTTReceipt)"
    return @{ typeTextFix = 'skipped:anchor-missing'; typeTextHash = $measureHash; typeTextProbe = 'unverified:anchor-missing' }
  }
  if ($countTTHelper -ne 1 -or $countTT -ne 1 -or $countTTReceipt -ne 1) {
    Say "dsh-cua-typetext: skipped (anchor ambiguous: helper=$countTTHelper effect=$countTT receipt=$countTTReceipt)"
    return @{ typeTextFix = 'skipped:anchor-ambiguous'; typeTextHash = $measureHash; typeTextProbe = 'unverified:anchor-ambiguous' }
  }

  $patched = $text.Replace($anchorTTHelper, $replacementTTHelper).Replace($anchorTT, $replacementTT).Replace($anchorTTReceipt, $replacementTTReceipt)
  if (($patched -eq $text) -or (-not $patched.Contains($sentinel))) {
    Say 'dsh-cua-typetext: skipped (the replacements produced no change)'
    return @{ typeTextFix = 'skipped:no-change'; typeTextHash = $measureHash; typeTextProbe = 'unverified:no-change' }
  }

  $writeError = ''
  $ttRestoreOk = $true
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($bridgePath, $patched, $utf8NoBom)
  } catch {
    $writeError = $_.Exception.Message
    # WriteAllText opens with Create (truncate) before it writes a byte, so a
    # throw here may have left an EMPTY or half-written bridge.py. Nothing is
    # reported as "skipped, nothing happened" until the original bytes are
    # MEASURED back in place.
    $ttRestoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
  }
  if ($writeError) {
    if ($ttRestoreOk) {
      Say "dsh-cua-typetext: skipped (bridge.py not writable: $writeError; the original bytes are back in place)"
    } else {
      Say "dsh-cua-typetext: NOT RESTORED (bridge.py was not writable: $writeError, and the rollback failed too) - $bridgePath may be truncated or partly written; reinstall dsh-cua==$expectedVersion"
    }
    return @{ typeTextFix = 'skipped:write-failed'; typeTextHash = $measureHash; typeTextProbe = 'unverified:write-failed'; restoreOk = $ttRestoreOk }
  }

  Clear-BridgePyc -BridgePath $bridgePath

  # THE PATCH IS NOT CALLED `applied` UNTIL THE MODULES STILL IMPORT: a bridge.py
  # that no longer loads is worse than an unpatched one, so the original bytes go
  # back and the refusal is recorded.
  $importCheck = Invoke-PythonCheck -PythonPath $py -Statement "import dsh_cua.bridge, dsh_cua.server; print('IMPORT_OK')"
  if ($importCheck.exit -ne 0) {
    $ttRestoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
    if ($ttRestoreOk) {
      Say "dsh-cua-typetext: import failed after the patch, reverted ($($importCheck.error))"
    } else {
      Say "dsh-cua-typetext: NOT RESTORED after a failed import ($($importCheck.error)) - $bridgePath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ typeTextFix = 'skipped:import-failed'; typeTextHash = $measureHash; typeTextProbe = 'unverified:import-failed'; restoreOk = $ttRestoreOk }
  }

  # THE SECOND CHECK IS THE RECEIPT ITSELF, answered by the helper this patch
  # installed: `short-insert` + the missing tail, exact equality, and the
  # unchanged case. `unverified:` means the probe could not run and the patch
  # stays with that fact recorded rather than being called a success.
  $typeTextProbe = Invoke-TypeTextProbe -PythonPath $py
  if ($typeTextProbe -like 'TYPE_TEXT_BAD*') {
    $ttRestoreOk = Restore-BridgeSource -BridgePath $bridgePath -OriginalBytes $originalBytes -ExpectedHash $measureHash
    if ($ttRestoreOk) {
      Say "dsh-cua-typetext: probe says $typeTextProbe after the patch, reverted"
    } else {
      Say "dsh-cua-typetext: NOT RESTORED after a bad probe ($typeTextProbe) - $bridgePath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ typeTextFix = 'skipped:probe-failed'; typeTextHash = $measureHash; typeTextProbe = $typeTextProbe; restoreOk = $ttRestoreOk }
  }

  Say "dsh-cua-typetext: applied on the $typeTextBase base + $typeTextProbe"
  return @{ typeTextFix = 'applied'; typeTextHash = $measureHash; typeTextProbe = $typeTextProbe; typeTextBase = $typeTextBase }
}

# R7/C11 - THE save_path ALLOW-LIST, INSTALLED IN PLACE UNDER A HASH GATE.
#
# THE DEFECT (upstream server.py:154-172): `tool_capture_window` opens the
# caller's `save_path` with no directory handling and no try/except, so
# `save_path="C:\cua-work\x.jpeg"` on a guest whose firstboot aborted raised
# `[Errno 2] No such file or directory` - and a screenshot is the only way to get
# a picture out of the guest, so that guest had no screenshot path except a
# %TEMP% default nobody knew about (R7). The mitigation in the tree
# (`Step 'cua-workdir'`) only helps images whose firstboot completed.
#
# THE FIX IS NOT A REDIRECT. save_path is never rewritten: the directory is
# created when it is under C:\cua-work or %TEMP%\win32_mcp_shots, and everything
# else fails closed with a sentence that names both roots. `created_dir` says
# whether THIS call made it.
#
# Same discipline as `dsh-cua-typetext`: pinned version, pinned SHA-256, every
# anchor counted once, import + probe before the word `applied`.
Step 'dsh-cua-savepath' {
  $expectedVersion = '0.4.1'
  $expectedHash = '29668590f5ed3b25e82bd8176bbf9268dd9b6108991943cb8db6ae5c7a2d8713'
  # THE IDEMPOTENCE SENTINEL: the helper name exists in the PATCHED server.py,
  # nowhere in the pinned one, and it is checked BEFORE the hash gate.
  $sentinel = '_ensure_save_dir'

  $py = Get-RealPython
  if (-not $py) {
    Say 'dsh-cua-savepath: skipped (no python interpreter)'
    return @{ savePathFix = 'skipped:no-python'; savePathHash = ''; savePathProbe = 'unverified:no-python' }
  }

  $serverPath = Get-PythonValue -PythonPath $py -Statement "import importlib.util;print(importlib.util.find_spec('dsh_cua.server').origin)"
  if (-not $serverPath -or -not (Test-Path -LiteralPath $serverPath -ErrorAction SilentlyContinue)) {
    Say "dsh-cua-savepath: skipped (server.py not found: '$serverPath')"
    return @{ savePathFix = 'skipped:no-file'; savePathHash = ''; savePathProbe = 'unverified:no-file' }
  }

  $measureHash = ''
  try { $measureHash = (Get-FileHash -LiteralPath $serverPath -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $measureHash = '' }

  $dshCuaVersion = Get-PythonValue -PythonPath $py -Statement "import importlib.metadata as m;print(m.version('dsh-cua'))"
  if ($dshCuaVersion -ne $expectedVersion) {
    Say "dsh-cua-savepath: skipped (dsh-cua '$dshCuaVersion' is not the pinned '$expectedVersion')"
    return @{ savePathFix = 'skipped:version-mismatch'; savePathHash = $measureHash; savePathProbe = 'unverified:version-mismatch' }
  }

  $originalBytes = $null
  $text = ''
  try {
    $originalBytes = [System.IO.File]::ReadAllBytes($serverPath)
    $text = [System.Text.Encoding]::UTF8.GetString($originalBytes).Replace("`r`n", "`n")
  } catch {
    Say "dsh-cua-savepath: skipped (server.py unreadable: $($_.Exception.Message))"
    return @{ savePathFix = 'skipped:no-file'; savePathHash = $measureHash; savePathProbe = 'unverified:unreadable' }
  }

  if ($text.Contains($sentinel)) {
    $alreadyProbe = Invoke-SavePathProbe -PythonPath $py
    Say "dsh-cua-savepath: already patched (probe $alreadyProbe)"
    return @{ savePathFix = 'already'; savePathHash = $measureHash; savePathProbe = $alreadyProbe }
  }

  if ($measureHash -ne $expectedHash) {
    Say "dsh-cua-savepath: skipped (sha256 $measureHash is not the pinned $expectedHash)"
    return @{ savePathFix = 'skipped:hash-mismatch'; savePathHash = $measureHash; savePathProbe = 'unverified:hash-mismatch' }
  }

  # THREE ANCHORS, EACH EXACTLY ONCE: the helper pair goes in above the tool (it
  # is inserted at the decorator line so it is extractable on its own), the open
  # block is replaced, and the success payload gains the two fields.
  $anchorSP = @'
    saved = ""
    if save_path:
        with open(save_path, "wb") as f: f.write(data)
        saved = save_path
'@
  $replacementSP = @'
    saved = ""
    created = False
    save_dir = ""
    if save_path:
        # [cua-D5] C11 - CREATE ONLY WHAT WE OWN, AND SAY WHAT WE CREATED.
        #
        # The caller's path is used VERBATIM (no silent temp fallback): what
        # changed is that its directory is created when - and only when - it is
        # under C:\cua-work or %TEMP%\win32_mcp_shots. Outside those roots nothing
        # is created and the open is allowed to fail with the sentence that names
        # both, which is the difference between "your path is wrong" and
        # "[Errno 2] No such file or directory" with no explanation.
        created, save_dir, save_err = _ensure_save_dir(save_path)
        if save_err:
            return {"success": False, "error": save_err, "created_dir": False}
        try:
            with open(save_path, "wb") as f: f.write(data)
        except OSError as exc:
            return {"success": False, "error": "save_path could not be written: %s" % (exc,), "created_dir": created}
        saved = save_path
'@
  $anchorSP2 = @'
@mcp.tool(description="Capture a window screenshot and SAVE IT TO A FILE.
'@
  $replacementSP2 = @'
def _save_path_dir(save_path):
    """The DIRECTORY a save_path names, in the form the allow-list compares."""
    return os.path.dirname(os.path.abspath(save_path))


def _same_dir(left, right):
    """Compare two paths the way Windows would: one separator, case folded.

    Normalising INSIDE the predicate is what makes the allow-list testable off
    Windows: `C:\\cua-work\\x` and `c:/CUA-WORK\\x` are the same directory to the
    guest, and a test on a Linux host must be able to say so without a guest.
    """
    a = str(left).replace("/", "\\").rstrip("\\").lower()
    b = str(right).replace("/", "\\").rstrip("\\").lower()
    if not a or not b:
        return False
    return a == b or a.startswith(b + "\\")


def _temp_shots_root():
    """The %TEMP%\\win32_mcp_shots root, ABSOLUTE.

    Absolute because the caller compares it with `os.path.abspath(save_path)`: a
    relative fallback (a service account with no environment, or a harness that
    only sets TEMP) would never match a real path and would turn a legal save into
    a refusal - a fail-closed rule is only useful when it is also correct.
    """
    base = os.environ.get("TEMP", ".") or "."
    return os.path.abspath(os.path.join(base, "win32_mcp_shots"))


def _is_allowed_save_dir(dirname):
    """True when `dirname` is C:\\cua-work or %TEMP%\\win32_mcp_shots, or below them.

    THE ALLOW-LIST IS THE WHOLE FIX (R7/C11). The old shape opened the caller's
    path with no directory handling at all, so a guest whose firstboot aborted had
    no screenshot path except a %TEMP% default nobody knew. Creating the directory
    is only safe where the desktop token can write; anywhere else must fail closed
    and SAY SO, because a silent redirect loses the file the caller asked for.
    """
    if not dirname:
        return False
    return _same_dir(dirname, "C:\\cua-work") or _same_dir(dirname, _temp_shots_root())


def _ensure_save_dir(save_path):
    """(created, dirname, error) for the directory a caller's save_path needs.

    NOT a redirect: save_path itself is never rewritten, and the %TEMP% default
    stays a default - this is only reached when the caller named a path. `created`
    is True only when THIS call made the directory, so a caller can tell "it was
    already there" from "I created it", and `error` (when set) is a sentence that
    names both roots. Nothing is created when the path is outside them.
    """
    if not save_path:
        return (False, "default", "")
    dirname = _save_path_dir(save_path)
    if os.path.isdir(dirname):
        return (False, dirname, "")
    if not _is_allowed_save_dir(dirname):
        return (False, dirname,
                "save_path directory '%s' does not exist and is not under C:\\cua-work or "
                "%%TEMP%%\\win32_mcp_shots; create it first or save under C:\\cua-work"
                % (dirname,))
    try:
        os.makedirs(dirname, exist_ok=True)
    except OSError as exc:
        return (False, dirname,
                "save_path directory '%s' could not be created: %s" % (dirname, exc))
    return (True, dirname, "")


@mcp.tool(description="Capture a window screenshot and SAVE IT TO A FILE.
'@
  $anchorSP3 = @'
           "capture_method": method, "saved_path": saved}
'@
  $replacementSP3 = @'
           "capture_method": method, "saved_path": saved,
           # [cua-D5] C11: what the CALLER's path needed (created here, or already
           # there) and the directory a reader can look in after a failure.
           "created_dir": created, "saved_dir": save_dir or ""}
'@
  $anchorSP = $anchorSP.Replace("`r`n", "`n")
  $replacementSP = $replacementSP.Replace("`r`n", "`n")
  $anchorSP2 = $anchorSP2.Replace("`r`n", "`n")
  $replacementSP2 = $replacementSP2.Replace("`r`n", "`n")
  $anchorSP3 = $anchorSP3.Replace("`r`n", "`n")
  $replacementSP3 = $replacementSP3.Replace("`r`n", "`n")

  $countSP = ([regex]::Matches($text, [regex]::Escape($anchorSP))).Count
  $countSP2 = ([regex]::Matches($text, [regex]::Escape($anchorSP2))).Count
  $countSP3 = ([regex]::Matches($text, [regex]::Escape($anchorSP3))).Count
  if ($countSP -eq 0 -or $countSP2 -eq 0 -or $countSP3 -eq 0) {
    Say "dsh-cua-savepath: skipped (anchor missing: open=$countSP helper=$countSP2 payload=$countSP3)"
    return @{ savePathFix = 'skipped:anchor-missing'; savePathHash = $measureHash; savePathProbe = 'unverified:anchor-missing' }
  }
  if ($countSP -ne 1 -or $countSP2 -ne 1 -or $countSP3 -ne 1) {
    Say "dsh-cua-savepath: skipped (anchor ambiguous: open=$countSP helper=$countSP2 payload=$countSP3)"
    return @{ savePathFix = 'skipped:anchor-ambiguous'; savePathHash = $measureHash; savePathProbe = 'unverified:anchor-ambiguous' }
  }

  $patched = $text.Replace($anchorSP, $replacementSP).Replace($anchorSP2, $replacementSP2).Replace($anchorSP3, $replacementSP3)
  if (($patched -eq $text) -or (-not $patched.Contains($sentinel))) {
    Say 'dsh-cua-savepath: skipped (the replacements produced no change)'
    return @{ savePathFix = 'skipped:no-change'; savePathHash = $measureHash; savePathProbe = 'unverified:no-change' }
  }

  $writeError = ''
  $spRestoreOk = $true
  # `Restore-BridgeSource` IS PATH-GENERIC (its name is historical - it was written
  # for the scale patch): path, original bytes, expected hash. Reusing it here is
  # deliberate; a second copy of the rollback is a second place for it to be wrong.
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($serverPath, $patched, $utf8NoBom)
  } catch {
    $writeError = $_.Exception.Message
    $spRestoreOk = Restore-BridgeSource -BridgePath $serverPath -OriginalBytes $originalBytes -ExpectedHash $measureHash -Filter 'server.*.pyc'
  }
  if ($writeError) {
    if ($spRestoreOk) {
      Say "dsh-cua-savepath: skipped (server.py not writable: $writeError; the original bytes are back in place)"
    } else {
      Say "dsh-cua-savepath: NOT RESTORED (server.py was not writable: $writeError, and the rollback failed too) - $serverPath may be truncated or partly written; reinstall dsh-cua==$expectedVersion"
    }
    return @{ savePathFix = 'skipped:write-failed'; savePathHash = $measureHash; savePathProbe = 'unverified:write-failed'; restoreOk = $spRestoreOk }
  }

  Clear-BridgePyc -BridgePath $serverPath -Filter 'server.*.pyc'

  $importCheck = Invoke-PythonCheck -PythonPath $py -Statement "import dsh_cua.bridge, dsh_cua.server; print('IMPORT_OK')"
  if ($importCheck.exit -ne 0) {
    $spRestoreOk = Restore-BridgeSource -BridgePath $serverPath -OriginalBytes $originalBytes -ExpectedHash $measureHash -Filter 'server.*.pyc'
    if ($spRestoreOk) {
      Say "dsh-cua-savepath: import failed after the patch, reverted ($($importCheck.error))"
    } else {
      Say "dsh-cua-savepath: NOT RESTORED after a failed import ($($importCheck.error)) - $serverPath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ savePathFix = 'skipped:import-failed'; savePathHash = $measureHash; savePathProbe = 'unverified:import-failed'; restoreOk = $spRestoreOk }
  }

  # THE PROBE ASSERTS BOTH HALVES: an allowed missing directory is created and
  # reported, and a directory under neither root is refused WITHOUT being created
  # (a silent makedirs there would be the redirect defect in a new place).
  $savePathProbe = Invoke-SavePathProbe -PythonPath $py
  if ($savePathProbe -like 'SAVE_PATH_BAD*') {
    $spRestoreOk = Restore-BridgeSource -BridgePath $serverPath -OriginalBytes $originalBytes -ExpectedHash $measureHash -Filter 'server.*.pyc'
    if ($spRestoreOk) {
      Say "dsh-cua-savepath: probe says $savePathProbe after the patch, reverted"
    } else {
      Say "dsh-cua-savepath: NOT RESTORED after a bad probe ($savePathProbe) - $serverPath is left patched; reinstall dsh-cua==$expectedVersion"
    }
    return @{ savePathFix = 'skipped:probe-failed'; savePathHash = $measureHash; savePathProbe = $savePathProbe; restoreOk = $spRestoreOk }
  }

  Say "dsh-cua-savepath: applied + $savePathProbe"
  return @{ savePathFix = 'applied'; savePathHash = $measureHash; savePathProbe = $savePathProbe }
}

# R9/C14 - THE DESKTOP TOKEN IS PROVEN AT BUILD TIME, NOT ASSUMED FROM THE
# MACHINE TOKEN.
#
# THE DEFECT (P2-2, and the root cause of the whole report): the lane was
# asserted by the `dsh-cua` step with `Get-RealPython`, i.e. as SYSTEM (or the
# elevated user) - the machine token. pywin32 is installed MACHINE-wide and this
# pass runs at HIGHEST, so `import win32ui` succeeds here even on a guest where
# the FILTERED desktop token cannot load it. The 3:1 report's image is exactly
# that guest: it built GREEN (marker ok:true) while every element-lane call failed
# at tool time with ImportError. There is no host-side fix for it; the build has to
# fail.
#
# SO: the same three assertions run ONCE MORE through an on-demand `/it /rl
# LIMITED` task - the same token shape the relay's child runs as - and the step
# THROWS when the marker is absent, stale, was written by a different script, or
# says any of the three booleans is false. Throwing is the RETRY MECHANISM (a
# step is only "done" when it is ok:true), so the logon pass re-runs it and the
# row keeps ok:false until a real desktop token passes it.
#
# The marker is a PROOF, not a status: it carries the probe script's own SHA-256
# and a per-attempt token, so a marker left over from an earlier boot cannot be
# read as this pass's evidence.
Step 'desktop-token-probe' {
  $probeDir = 'C:\ProgramData\cua'
  $probeScript = Join-Path $probeDir 'desktop-probe.ps1'
  $probeMarker = 'C:\cua-work\cua-desktop-probe.json'
  $probeToken = [guid]::NewGuid().ToString('n')

  $py = Get-RealPython
  if (-not $py) {
    $script:pendingStepAnnotation = @{ desktopProbe = 'failed:no-python'; desktopSession = -1; desktopScriptSha256 = '' }
    throw 'desktop-token-probe: no python interpreter, so the desktop token was NOT proven (the python step did not run)'
  }
  if (-not $relayAccount) {
    $script:pendingStepAnnotation = @{ desktopProbe = 'failed:no-account'; desktopSession = -1; desktopScriptSha256 = '' }
    throw 'desktop-token-probe: no provisioned local account could be resolved, so no /it task can be bound to the desktop'
  }

  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null

  # THE PROBE BODY IS ASCII AND SELF-CONTAINED. It hard-codes the interpreter
  # path because a task has no environment (the same reason the relay's launcher
  # carries its interpreter), and it hashes ITSELF at run time - a firstboot that
  # compares the marker with the file it just wrote therefore compares the file
  # that actually ran, not a value baked in before the write.
  $probeText = @'
# cua-desktop-probe - generated by cua-firstboot.ps1. Runs as the DESKTOP token.
$ErrorActionPreference = 'Continue'
$py = '__CUA_PY__'
$marker = 'C:\cua-work\cua-desktop-probe.json'
$probe = @{
  schema = 1
  at = (Get-Date).ToUniversalTime().ToString('o')
  user = [string]$env:USERNAME
  session = -1
  win32ui = $false
  uiaLane = $false
  workDirWritable = $false
  scriptSha256 = ''
  probeToken = '__CUA_TOKEN__'
}
try { $probe.session = [int]([System.Diagnostics.Process]::GetCurrentProcess().SessionId) } catch { }
& $py -c "import win32ui, win32gui" 2>$null | Out-Null
$probe.win32ui = ($LASTEXITCODE -eq 0)
& $py -c "import pywinauto.controls.uiawrapper; print('UIA_OK')" 2>$null | Out-Null
$probe.uiaLane = ($LASTEXITCODE -eq 0)
try {
  Set-Content -LiteralPath 'C:\cua-work\.desktop-probe' -Value 'ok' -Encoding ASCII -ErrorAction Stop
  $probe.workDirWritable = (Test-Path -LiteralPath 'C:\cua-work\.desktop-probe')
} catch { $probe.workDirWritable = $false }
Remove-Item -LiteralPath 'C:\cua-work\.desktop-probe' -Force -ErrorAction SilentlyContinue
try { $probe.scriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
$probe | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $marker -Encoding ASCII
'@
  $probeText = $probeText.Replace('__CUA_PY__', $py).Replace('__CUA_TOKEN__', $probeToken)
  try {
    Set-Content -LiteralPath $probeScript -Value $probeText -Encoding ASCII -ErrorAction Stop
  } catch {
    $script:pendingStepAnnotation = @{ desktopProbe = 'failed:probe-write'; desktopSession = -1; desktopScriptSha256 = '' }
    throw "desktop-token-probe: could not write $probeScript ($($_.Exception.Message))"
  }
  # C14 says the probe script is hidden: it is machinery, and a reader who finds
  # it in ProgramData must find the marker next to it, not a stray script.
  try { (Get-Item -LiteralPath $probeScript).Attributes = [System.IO.FileAttributes]::Hidden } catch { }
  $probeHash = ''
  try { $probeHash = (Get-FileHash -LiteralPath $probeScript -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $probeHash = '' }
  if (-not $probeHash) {
    $script:pendingStepAnnotation = @{ desktopProbe = 'failed:no-probe-hash'; desktopSession = -1; desktopScriptSha256 = '' }
    throw "desktop-token-probe: could not hash $probeScript, so the marker could not be tied to the script that wrote it"
  }

  # /it /rl LIMITED IS THE SAME SHAPE THE RELAY USES: interactive (the user's
  # session) and the user's own filtered token - not HIGHEST, which would run on a
  # different desktop and prove nothing about the lane the tools get. /ru names
  # the account explicitly: /it WITHOUT /ru binds the task to the CALLER, which is
  # the machine account in the SYSTEM pass, and Windows refuses that create.
  $trProbe = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $probeScript"
  $probeCmd = Join-Path $env:TEMP 'cua-desktop-probe.cmd'
  @("schtasks /create /tn `"cua-desktop-probe`" /sc ondemand /ru `"$relayAccount`" /it /rl LIMITED /f /tr `"$trProbe`"") |
    Set-Content -Path $probeCmd -Encoding ASCII
  & cmd /c $probeCmd
  $createExit = $LASTEXITCODE
  Remove-Item -Force $probeCmd -ErrorAction SilentlyContinue
  if ($createExit -ne 0) {
    $script:pendingStepAnnotation = @{ desktopProbe = 'failed:task-create'; desktopSession = -1; desktopScriptSha256 = $probeHash }
    throw "desktop-token-probe: schtasks could not register cua-desktop-probe (exit $createExit); the desktop token is NOT proven"
  }

  # A PREVIOUS MARKER MUST NOT BE READ AS THIS PASS'S EVIDENCE: delete it before
  # the run (the token and the boot-time check below are the second and third
  # guards, because a delete can fail).
  Remove-Item -LiteralPath $probeMarker -Force -ErrorAction SilentlyContinue
  $bootAt = (Get-Date).ToUniversalTime().AddMilliseconds(-[Environment]::TickCount64)
  & schtasks.exe /run /tn 'cua-desktop-probe' 2>&1 | Out-Null
  $runExit = $LASTEXITCODE

  $deadline = (Get-Date).AddSeconds(30)
  $markerInfo = $null
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $probeMarker -ErrorAction SilentlyContinue) {
      try { $markerInfo = Get-Content -LiteralPath $probeMarker -Raw | ConvertFrom-Json } catch { $markerInfo = $null }
      if ($markerInfo) { break }
    }
    Start-Sleep -Milliseconds 500
  }

  $desktopSession = -1
  if ($markerInfo) {
    try { $desktopSession = [int]$markerInfo.session } catch { $desktopSession = -1 }
  }
  $why = ''
  if (-not $markerInfo) {
    $why = 'no-marker'
  } elseif ([string]$markerInfo.probeToken -ne $probeToken) {
    $why = 'stale-marker'
  } elseif ([string]$markerInfo.scriptSha256 -ne $probeHash) {
    $why = 'script-mismatch'
  } else {
    $markerAt = $null
    try { $markerAt = ([datetime]::Parse([string]$markerInfo.at)).ToUniversalTime() } catch { $markerAt = $null }
    if (-not $markerAt -or $markerAt -lt $bootAt) {
      $why = 'stale-boot'
    } elseif ($desktopSession -le 0) {
      # JD3 - A SESSION-0 PROBE PROVES NOTHING. The entire point of this step is
      # that the DESKTOP token (not the machine token) can load the lane; a task
      # that ran in Session 0 - no logged-on user, or `/it` ignored - answered with
      # the machine's rights, which is the R9 lie in a new place. A failed
      # SessionId read (-1) is the same answer: unproven. Checked BEFORE the three
      # booleans, because a Session-0 run can make all three true.
      $why = 'no-session'
    } elseif ($markerInfo.win32ui -ne $true) {
      $why = 'win32ui-false'
    } elseif ($markerInfo.uiaLane -ne $true) {
      $why = 'uialane-false'
    } elseif ($markerInfo.workDirWritable -ne $true) {
      $why = 'workdir-false'
    }
  }

  if ($why) {
    $script:pendingStepAnnotation = @{ desktopProbe = ('failed:' + $why); desktopSession = $desktopSession; desktopScriptSha256 = $probeHash }
    # THE THROW IS THE POINT: ok:false is what makes the next pass try again, and
    # a guest that cannot prove the lane must not read as provisioned.
    throw "desktop-token-probe: the DESKTOP token did not prove the lane ($why); marker '$probeMarker' after 30 s (task run exit $runExit, session $desktopSession, script $probeHash)"
  }

  Say "desktop-token-probe: ok (session $desktopSession, win32ui/uiaLane/workDirWritable all true, script $probeHash)"
  return @{ desktopProbe = 'ok'; desktopSession = $desktopSession; desktopScriptSha256 = $probeHash }
}

Step 'clipboard-tasks' {
  # U2: THE CLIPBOARD BRIDGE, SESSION 2 ONLY.
  #
  # The RFB route (ClientCutText) is dead here: the Windows guest runs a bare
  # QEMU VNC server with NO clipboard agent, so a ClientCutText is accepted by
  # QEMU and dropped by the desktop - a human who pasted got the guest's OLD
  # clipboard, not the text that was sent. `Set-Clipboard` over SSH is dead for
  # the same reason the desktop is unreachable from SSH: sshd runs in Session 0,
  # which owns a different (empty) clipboard than the interactive session the
  # user sees.
  #
  # So the clipboard is moved by TWO on-demand tasks, each of which runs
  # `/it` - IN THE INTERACTIVE USER SESSION - which is the only place
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

# cua-clip-agent: the in-session clipboard loop (bidirectional). Marker key is
# new so a machine already marked "clipboard-tasks: ok" still gets it.
#
# WHY THIS IS A SECOND STEP AND NOT PART OF `clipboard-tasks`: the two on-demand
# tasks above are the DIRECTED path (the supervisor says "paste this now"). This
# one is the AMBIENT path: it watches the session's clipboard so a human who
# copies in Notepad is visible to the harness without anyone asking, and it
# applies requests the supervisor leaves in outbox\clip-*.json. It must run
# continuously, so it is a separate `onlogon` task in the same interactive
# session - a machine that already finished `clipboard-tasks` still needs it,
# which is exactly what a new marker key buys.
Step 'clip-agent-task' {
  # THE PRIVACY OFF-SWITCH (J20-1b), AND ITS CONTRACT WITH docker/cua-clip-agent.ps1
  # ---------------------------------------------------------------------------
  # DSH_CUA_CLIP_AGENT=0 means "do not run the ambient clipboard loop". This
  # script CANNOT read the host environment - the flag is an image-build variable
  # and the guest has no way back to it - so the switch is materialized as a FILE
  # named `clip-agent-disabled`, and that single file travels in TWO STAGES:
  #
  #   STAGE 1 - THE BACKEND, AT INSTALL TIME (another lane's code, named here so
  #   the contract is one paragraph instead of an assumption). When
  #   DSH_CUA_CLIP_AGENT=0 it stages the file named `clip-agent-disabled` in
  #   BOTH places the guest can still read during and after Setup:
  #
  #         <setup.img root>\clip-agent-disabled      the answer medium, beside
  #                                                   Autounattend.xml
  #         $OEM$\$$\Setup\Scripts\clip-agent-disabled   what Setup copies into
  #                                                   C:\Windows\Setup\Scripts
  #
  #   STAGE 2 - THIS SCRIPT, AT FIRSTBOOT (the block right below). It searches
  #   the known staging locations for that file name and COPIES it to the one
  #   canonical path every consumer reads:
  #
  #         C:\ProgramData\cua\clip-agent-disabled    (sentinel; exists = disabled)
  #
  #   WITHOUT STAGE 2 THE SWITCH IS SILENTLY OFF: the backend's file sits on the
  #   medium and in Setup\Scripts, the check below tests ProgramData, finds
  #   nothing, and the ambient loop is registered anyway. That gap is the defect
  #   this pair of blocks closes.
  #
  # BOTH CONSUMERS READ THE CANONICAL PATH: the check below (before the task is
  # registered) and docker/cua-clip-agent.ps1 at startup (it exits quietly
  # there, so a machine whose task was registered before the switch was flipped
  # also stops); the embedded fallback copy below repeats the same
  # search-then-stage hop, so a guest that runs the agent out of ProgramData
  # honours the switch too. Sentinel present -> this step registers NOTHING and
  # starts NOTHING, and records the skip in the audit marker: `skipped = $true`,
  # never a plain ok:true that would read as "registered".

  # STAGE 2 (the half that was missing). SEARCH-THEN-STAGE, additive by
  # construction: when no staged copy exists anywhere, nothing is written, no
  # directory is created, and the check below runs against exactly the state it
  # always ran against. The directory list is the SAME one the OEM payload
  # search uses further down ($PSScriptRoot, Setup\Scripts, and the removable
  # roots Setup hands the answer medium), so both the setup.img ROOT copy and
  # the $OEM$ copy are reached, plus a copy already put in place by hand.
  #
  # -ErrorAction SilentlyContinue on the probes IS NOT DECORATION: a bare
  # Test-Path against a drive letter this guest does not have (a machine with no
  # G:) is an error, and the same block in the embedded copy below runs under
  # $ErrorActionPreference = 'Stop'. A missing drive must read as "not there",
  # never as "the step failed".
  $sentinelName = 'clip-agent-disabled'
  $sentinelPath = 'C:\ProgramData\cua\clip-agent-disabled'
  if (-not (Test-Path -LiteralPath $sentinelPath -ErrorAction SilentlyContinue)) {
    $sentinelDirs = @($PSScriptRoot, 'C:\Windows\Setup\Scripts', 'C:\ProgramData\cua', 'C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')
    foreach ($sentinelDir in $sentinelDirs) {
      if (-not $sentinelDir) { continue }
      $sentinelStaged = Join-Path $sentinelDir $sentinelName
      if (-not (Test-Path -LiteralPath $sentinelStaged -ErrorAction SilentlyContinue)) { continue }
      # The clipboard step creates ProgramData\cua, but a -Force run against a
      # partly wiped install must not fail on a missing directory: create it.
      New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua' | Out-Null
      Copy-Item -LiteralPath $sentinelStaged -Destination $sentinelPath -Force
      Say "clip agent: staged sentinel $sentinelStaged -> $sentinelPath"
      break
    }
  }

  if (Test-Path -LiteralPath 'C:\ProgramData\cua\clip-agent-disabled') {
    Say 'clip agent: DISABLED by the privacy off-switch (clip-agent-disabled present); task NOT registered'
    return @{ skipped = $true; reason = 'clip-agent-disabled' }
  }

  $agentScript = 'C:\ProgramData\cua\clip-agent.ps1'
  New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua\outbox' | Out-Null

  # THE BODY COMES FROM THE OEM PAYLOAD, and the payload is searched where Setup
  # actually put it: next to this script ($PSScriptRoot), in Setup\Scripts (where
  # setupcomplete.cmd and this file land), and on the roots of the removable
  # media the fallback boot path uses (FIRSTBOOT_FALLBACK_COMMAND in
  # cua-vm-windows-qemu.mjs walks C:..H: the same way).
  #
  # THE EMBEDDED COPY IS THE FLOOR, NOT THE PREFERRED PATH. An image whose OEM
  # payload predates this file (no cua-clip-agent.ps1 staged) would otherwise
  # register a task whose -File points at nothing: a task that exists, reports
  # success and does nothing - the exact failure this repository keeps naming.
  # docker/cua-clip-agent.ps1 is the source of truth; the inline text below is
  # THAT FILE VERBATIM except for comment-only and blank lines (generated, not
  # hand-copied), so the loop logic - [long] seq, the clip-current-before-ack
  # order, the text-length size test, the per-session paths and the owner lock -
  # is identical on both paths. Only the files are absent-or-present, not the code.
  $agentSource = $null
  $searchDirs = @($PSScriptRoot, 'C:\Windows\Setup\Scripts', 'C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')
  foreach ($dir in $searchDirs) {
    if (-not $dir) { continue }
    $candidate = Join-Path $dir 'cua-clip-agent.ps1'
    if (Test-Path -LiteralPath $candidate) { $agentSource = $candidate; break }
  }
  if ($agentSource) {
    Copy-Item -LiteralPath $agentSource -Destination $agentScript -Force
    Say "clip agent: $agentSource -> $agentScript"
  } else {
    Set-Content -Path $agentScript -Encoding ASCII -Value @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$Dir = 'C:\ProgramData\cua'
# SEARCH-THEN-STAGE, THE SAME HOP AS cua-firstboot.ps1: the backend stages a file
# named clip-agent-disabled on the answer medium and into Setup\Scripts, while the
# sentinel this loop honours lives in $Dir. Copy a staged one into place first, so
# a guest that is only reachable through the medium still stops. Additive: no
# staged copy anywhere means no write, no directory change, no behaviour change.
# -ErrorAction SilentlyContinue: a drive letter this guest does not have must read
# as "not there" (this file runs under $ErrorActionPreference = 'Stop').
if (-not (Test-Path -LiteralPath (Join-Path $Dir 'clip-agent-disabled') -ErrorAction SilentlyContinue)) {
  foreach ($stagedDir in @($PSScriptRoot, 'C:\Windows\Setup\Scripts', 'C:\ProgramData\cua', 'C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')) {
    if (-not $stagedDir) { continue }
    $stagedSentinel = Join-Path $stagedDir 'clip-agent-disabled'
    if (-not (Test-Path -LiteralPath $stagedSentinel -ErrorAction SilentlyContinue)) { continue }
    try {
      New-Item -ItemType Directory -Force -Path $Dir | Out-Null
      Copy-Item -LiteralPath $stagedSentinel -Destination (Join-Path $Dir 'clip-agent-disabled') -Force
    } catch { }
    break
  }
}
if (Test-Path -LiteralPath (Join-Path $Dir 'clip-agent-disabled')) { exit 0 }
$sessionId = 0
try { $sessionId = [int](Get-Process -Id $PID).SessionId } catch { $sessionId = 0 }
$SessionTag = '-' + [string]$sessionId
$Outbox = Join-Path $Dir 'outbox'
$OutboxSession = Join-Path $Dir ('outbox' + $SessionTag)
$CurrentPath = Join-Path $Dir 'clip-current.txt'
$CurrentPathSession = Join-Path $Dir ('clip-current' + $SessionTag + '.txt')
$StatePath = Join-Path $Dir 'clip-state.json'
$StatePathSession = Join-Path $Dir ('clip-state' + $SessionTag + '.json')
$AckPath = Join-Path $Dir 'clip-ack.json'
$AckPathSession = Join-Path $Dir ('clip-ack' + $SessionTag + '.json')
$PollMs = 400
$MaxChars = 1048576
$MaxOutboxPerCycle = 4
$OwnerWindowSeconds = 60
$HeartbeatSeconds = 30
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
New-Item -ItemType Directory -Force -Path $Outbox | Out-Null
New-Item -ItemType Directory -Force -Path $OutboxSession | Out-Null
function Get-Sha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $Utf8NoBom.GetBytes($Text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}
function Get-NowIso {
  return (Get-Date).ToString('o', $Invariant)
}
function Write-JsonPair([string]$Canonical, [string]$Scoped, $Object) {
  $json = $Object | ConvertTo-Json -Depth 4 -Compress
  [System.IO.File]::WriteAllText($Scoped, $json, $Utf8NoBom)
  [System.IO.File]::WriteAllText($Canonical, $json, $Utf8NoBom)
}
function Write-TextPair([string]$Canonical, [string]$Scoped, [string]$Text) {
  [System.IO.File]::WriteAllText($Scoped, $Text, $Utf8NoBom)
  [System.IO.File]::WriteAllText($Canonical, $Text, $Utf8NoBom)
}
function Test-SessionAlive([int]$Session) {
  try {
    return (@(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.SessionId -eq $Session } |
      Select-Object -First 1).Count -gt 0)
  } catch { return $true }
}
function Test-OtherOwner {
  $cutoff = [DateTime]::UtcNow.AddSeconds(-$OwnerWindowSeconds)
  foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Filter 'clip-state-*.json' -File -ErrorAction SilentlyContinue)) {
    $idText = $item.BaseName.Substring('clip-state'.Length).TrimStart('-')
    $id = -1
    if (-not [int]::TryParse($idText, [ref]$id)) { continue }
    if ($id -eq $sessionId) { continue }
    if ($item.LastWriteTimeUtc -gt $cutoff -and (Test-SessionAlive $id)) { return $true }
  }
  if (Test-Path -LiteralPath $StatePath) {
    try {
      $legacy = Get-Item -LiteralPath $StatePath
      if ($legacy.LastWriteTimeUtc -gt $cutoff) {
        $owner = -1
        try {
          $declared = ([System.IO.File]::ReadAllText($StatePath, $Utf8NoBom) | ConvertFrom-Json).session
          if ($null -ne $declared) { $owner = [int]$declared }
        } catch { $owner = -1 }
        if ($owner -ge 0 -and $owner -ne $sessionId -and (Test-SessionAlive $owner)) { return $true }
      }
    } catch { }
  }
  return $false
}
function Update-Heartbeat {
  $now = [DateTime]::UtcNow
  foreach ($path in @($StatePathSession, $StatePath)) {
    try {
      if (Test-Path -LiteralPath $path) { [System.IO.File]::SetLastWriteTimeUtc($path, $now) }
    } catch { }
  }
}
function Read-ClipboardText {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      $value = [System.Windows.Forms.Clipboard]::GetText()
      if ($null -eq $value) { return '' }
      return [string]$value
    } catch {
      Start-Sleep -Milliseconds (40 * ($attempt + 1))
    }
  }
  return $null
}
function Write-ClipboardState([string]$Text, [long]$Seq, [int]$Session) {
  $state = @{
    seq = $Seq
    sha256 = Get-Sha256 $Text
    chars = $Text.Length
    at = Get-NowIso
    session = $Session
  }
  Write-TextPair $CurrentPath $CurrentPathSession $Text
  Write-JsonPair $StatePath $StatePathSession $state
}
function Invoke-OutboxItem($File, [int]$Session) {
  [long]$seq = 0
  $wantAck = $true
  $ok = $false
  $equal = $false
  $error = $null
  $readBack = ''
  $expected = ''
  $pasted = $false
  try {
    $raw = [System.IO.File]::ReadAllText($File.FullName, $Utf8NoBom)
    $request = $raw | ConvertFrom-Json
    $seq = [long]$request.seq
    $text = [string]$request.text
    if ($null -ne $request.wantAck) { $wantAck = [bool]$request.wantAck }
    $expected = Get-Sha256 $text
    if ($text.Length -gt $MaxChars) {
      $error = 'too-large'
    } else {
      Set-Clipboard -Value $text
      $pasted = $true
      Start-Sleep -Milliseconds 60
      $readBack = [string](Get-Clipboard -Raw)
      $equal = ($readBack -ceq $text)
      $ok = $equal
      if (-not $ok) { $error = 'readback-mismatch' }
    }
  } catch {
    $error = $_.Exception.Message
  }
  if ($pasted) {
    try { Write-TextPair $CurrentPath $CurrentPathSession $readBack } catch { }
  }
  if ($wantAck) {
    if ((-not $error) -and (-not $ok)) { $error = 'paste-not-applied' }
    $ack = @{
      seq = $seq
      ok = $ok
      sha256 = $expected
      readBack = $readBack
      equal = $equal
      at = Get-NowIso
      error = $error
    }
    try { Write-JsonPair $AckPath $AckPathSession $ack } catch { }
  }
  try { Remove-Item -LiteralPath $File.FullName -Force } catch { }
}
function Invoke-Outbox([int]$Session) {
  $pending = @()
  foreach ($dir in @($OutboxSession, $Outbox)) {
    $pending += @(Get-ChildItem -LiteralPath $dir -Filter 'clip-*.json' -File -ErrorAction SilentlyContinue)
  }
  $pending = @($pending | Sort-Object LastWriteTime | Select-Object -First $MaxOutboxPerCycle)
  foreach ($file in $pending) {
    Invoke-OutboxItem $file $Session
  }
}
$seq = [long]0
$lastSha = ''
foreach ($candidate in @($StatePathSession, $StatePath)) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  try {
    $previous = [System.IO.File]::ReadAllText($candidate, $Utf8NoBom) | ConvertFrom-Json
    if ($null -ne $previous.seq) { $seq = [long]$previous.seq }
    if ($null -ne $previous.sha256) { $lastSha = [string]$previous.sha256 }
    break
  } catch { }
}
$published = $false
$lastBeat = [DateTime]::UtcNow
while ($true) {
  if (Test-OtherOwner) {
    Start-Sleep -Seconds 60
    continue
  }
  try { Invoke-Outbox $sessionId } catch { }
  $text = Read-ClipboardText
  if ($null -ne $text) {
    $sha = Get-Sha256 $text
    if (($sha -ne $lastSha) -or (-not $published)) {
      $advanced = $false
      if ($sha -ne $lastSha) { $seq += 1; $advanced = $true }
      try {
        Write-ClipboardState $text $seq $sessionId
        $lastSha = $sha
        $published = $true
        $lastBeat = [DateTime]::UtcNow
      } catch {
        if ($advanced) { $seq -= 1 }
      }
    }
  }
  if ($published -and ((([DateTime]::UtcNow) - $lastBeat).TotalSeconds -ge $HeartbeatSeconds)) {
    Update-Heartbeat
    $lastBeat = [DateTime]::UtcNow
  }
  Start-Sleep -Milliseconds $PollMs
}
'@
    Say 'clip agent: the OEM payload had no cua-clip-agent.ps1; wrote the embedded copy'
  }

  # /sc onlogon + /it = the loop starts with the interactive session, which is
  # the only session whose clipboard the user can see and touch. /rl LIMITED =
  # the user's own token (elevation would move it to another desktop).
  #
  # THROUGH A .cmd FILE FOR THE SAME REASON AS THE TASKS ABOVE: Windows
  # PowerShell 5.1 hands a variable containing spaces to a native program
  # unquoted, so `& schtasks /tr $tr` arrives as `/tr powershell.exe -NoProfile
  # ...` and schtasks takes only `powershell.exe` as the action. cmd parses the
  # quoted argument the documented way.
  $agentTr = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $agentScript"
  $agentCmd = Join-Path $env:TEMP 'cua-clip-agent.cmd'
  @("schtasks /create /tn `"cua-clip-agent`" /sc onlogon /it /rl LIMITED /f /tr `"$agentTr`"") |
    Set-Content -Path $agentCmd -Encoding ASCII
  & cmd /c $agentCmd
  $agentExit = $LASTEXITCODE
  Remove-Item -Force $agentCmd -ErrorAction SilentlyContinue
  if ($agentExit -ne 0) { throw "schtasks could not register cua-clip-agent (exit $agentExit)" }
  # Run it now instead of waiting for the next logon: a machine that is already
  # logged in is the common case when firstboot is re-run.
  #
  # 'started' IS NOT WHAT schtasks /run PROVES (J22-13). Its exit code says Task
  # Scheduler ACCEPTED the request; a task whose -File points at nothing also
  # "starts" and exits immediately, and the old code recorded ok:true for it. The
  # proof is the loop's own writes: it publishes clip-state*.json as soon as it
  # owns the session and heartbeats the stamp every 30 s, so the stamp is local
  # evidence that the loop is alive.
  #
  # A LOOP THAT IS ALREADY ALIVE GETS NO SECOND INSTANCE: at logon the task is
  # already running, and a -Force firstboot would otherwise start one more loop in
  # the same session, where the two would race for the same outbox request. A
  # state stamp fresher than the loop's own 60 s lock window is that check.
  $stateDir = 'C:\ProgramData\cua'
  $before = Get-ClipStateStamps $stateDir
  $freshCutoff = ([DateTime]::UtcNow.AddSeconds(-60)).Ticks
  $proven = (@($before.Values | Where-Object { $_ -gt $freshCutoff }).Count -gt 0)
  if ($proven) {
    Say 'clip agent: an instance is already running (state file fresher than 60 s); not started again'
  } else {
    & schtasks /run /tn 'cua-clip-agent' | Out-Null
    $runExit = $LASTEXITCODE
    if ($runExit -ne 0) { throw "schtasks could not start cua-clip-agent (exit $runExit)" }
    for ($probe = 0; $probe -lt 20; $probe++) {
      # 20 x 500 ms = 10 s. A cold powershell.exe plus Add-Type of WinForms is the
      # slow part, not the loop itself, so a couple of seconds of patience is owed
      # to the first start of a session.
      Start-Sleep -Milliseconds 500
      $after = Get-ClipStateStamps $stateDir
      foreach ($path in $after.Keys) {
        if ((-not $before.ContainsKey($path)) -or ($after[$path] -gt $before[$path])) { $proven = $true; break }
      }
      if ($proven) { break }
    }
    if (-not $proven) {
      # FAILED, not success: "a task that exists and does nothing" is the failure
      # mode this repository keeps naming, and a marker that says ok lets the next
      # run skip the step forever.
      throw 'task-started-but-no-state'
    }
  }
  Say 'clip agent registered (cua-clip-agent: onlogon, interactive, hidden) and running (state file confirmed)'
}

# THE STEP IS RENAMED ON PURPOSE. It used to be `autostart-task`, and a computer
# whose marker already says `autostart-task: ok` would SKIP its body - i.e. every
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
  #      visible console window on the desktop - the reported defect. The fix is
  #      `pythonw.exe` (the windowless interpreter that ships beside python.exe)
  #      plus `-Hidden` on the task itself; if an unusual install has no
  #      pythonw.exe, a `powershell -WindowStyle Hidden` wrapper gets the same
  #      result.
  #   2. It passed `--pipe \\.\pipe\dsh-cua`, an argument that does not exist:
  #      upstream `dsh_cua.server main()` takes no pipe option. The named pipe
  #      in win-mcp.js's diagram was therefore never created - the SSH side
  #      starts its OWN stdio server per session, and the two never met. The
  #      argument is gone rather than documented as broken.
  #
  # WHAT THIS MEANS, HONESTLY: with a stdio-only upstream, ONE shared session-2
  # server cannot be reached over SSH yet. The MCP attach keeps working as it
  # really does - an independent stdio server per SSH session (19 tools) - and
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

# THE BOOT GUARD - STEP 1 OF THE LANE, AND THE ONLY THING THAT RUNS AFTER OOBE.
#
# WHY IT HAS TO EXIST: the relay is started by an `onlogon` task, and nothing
# re-asserts the lane after OOBE - cua-firstboot.ps1 never runs again (the
# supervisor has no re-provision path). So a boot that produces no logon (an
# autologon that expired, a restore that resumes before Winlogon, a task that was
# refused in the SYSTEM pass and never re-registered) leaves the harness attached
# to a blind Session 0 with a perfectly healthy relay that simply is not running.
# The guard task makes "the lane is up" a BOOT property instead of a logon-time
# accident, and it is also the repair path a failed mcp-relay-task leaves behind.
#
# /sc onstart + /ru SYSTEM: it must run BEFORE - and without - any logon, and
# SYSTEM is the only principal that exists at that point. /rl HIGHEST is what
# lets it write the Winlogon autologon values. -Boot is the mode that does the
# whole job: autologon re-assert, wait up to 90 s for an Active console session,
# handshake first, then register/run only what is missing and only when silent.
#
# THE TASK NAMES A FILE THAT EXISTS: the guard is staged to C:\ProgramData\cua
# first, and a missing guard fails this step instead of registering a task that
# "starts" and does nothing - the failure mode this repository keeps naming.
Step 'relay-guard-task' {
  New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua' | Out-Null
  $guardScript = 'C:\ProgramData\cua\cua-relay-guard.ps1'
  $guardSource = Find-OemPayloadFile -Name 'cua-relay-guard.ps1'

  # WP-1A - MEASURE, THEN WRITE. This used to be an unconditional copy with
  # `-Force`, so every pass rewrote the guard even when the bytes were identical -
  # mtime churn on the one file the boot guard runs, and no way for the marker to
  # say "the guard is current" instead of "I wrote it again". Now both sides are
  # hashed first: equal means nothing is written and the row records a MEASURED
  # `already current`, different means the payload copy lands (so a guest whose OEM
  # copy is newer converges, which is the direction this step is for).
  #
  # A MISSING OR UNMEASURABLE HASH IS NOT "EQUAL": the write happens unless BOTH
  # sides were measured and they match, because "I could not measure it" must not
  # be read as "it is current" - that is the same class of lie as a patch that
  # claims `applied` without its probe.
  $stagedHash = ''
  try {
    if (Test-Path -LiteralPath $guardScript -ErrorAction SilentlyContinue) {
      $stagedHash = (Get-FileHash -LiteralPath $guardScript -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } catch { $stagedHash = '' }
  $sourceHash = ''
  if ($guardSource) {
    try { $sourceHash = (Get-FileHash -LiteralPath $guardSource -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $sourceHash = '' }
  }
  $stagedPresent = [bool](Test-Path -LiteralPath $guardScript -ErrorAction SilentlyContinue)
  $copyGuard = $false
  if ($guardSource) {
    if (-not $stagedPresent) { $copyGuard = $true }
    elseif (-not $sourceHash) { $copyGuard = $true }
    elseif (-not $stagedHash) { $copyGuard = $true }
    elseif ($sourceHash -ne $stagedHash) { $copyGuard = $true }
  }
  $guardState = ''
  if ($copyGuard) {
    # JURY DEFECT 7 - THE COPY IS NOT CALLED `staged` UNTIL THE STAGED FILE IS
    # MEASURED to BE the source bytes. This block used to set `staged` around an
    # unconditional copy while the script runs under
    # $ErrorActionPreference = 'Continue', so a FAILED copy was not even
    # catchable: the row said `staged` while the disk still held the old file (the
    # `guardSha256` field stayed honest only because it is re-read later - the WORD
    # a human reads did not). `-ErrorAction Stop` makes the failure catchable, and
    # the re-hash makes the word a MEASUREMENT, the same rule as the two hashes
    # that decided to copy in the first place.
    $copyError = ''
    try {
      Copy-Item -LiteralPath $guardSource -Destination $guardScript -Force -ErrorAction Stop
    } catch {
      $copyError = $_.Exception.Message
    }
    $afterCopyHash = ''
    try { $afterCopyHash = (Get-FileHash -LiteralPath $guardScript -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $afterCopyHash = '' }
    if ($afterCopyHash -and $afterCopyHash -eq $sourceHash) {
      $guardState = 'staged'
      if ($copyError) {
        # The cmdlet complained and the bytes still landed (a transient lock, an AV
        # scan): the measurement wins, and the log says which one it was.
        Say "relay guard: the copy reported an error, but the staged file MEASURES as the source ($afterCopyHash); recording 'staged'"
      } else {
        Say "relay guard: $guardSource -> $guardScript (sha256=$afterCopyHash)"
      }
    } else {
      # A STALE OR ABSENT GUARD WITH A REGISTERED TASK IS THE "task that does
      # nothing" FAILURE this step already throws on when neither side exists -
      # a failed copy is the same fact one line later. Record the MEASURED word on
      # the row and throw, so the next pass retries instead of the marker claiming
      # a write that did not happen.
      $guardState = 'copy-failed'
      $script:pendingStepAnnotation = @{ guardState = 'copy-failed'; guardSha256 = $afterCopyHash }
      Say "relay guard: COPY FAILED ($copyError) - $guardScript measures '$afterCopyHash', not the source '$sourceHash'"
      throw "relay guard: '$guardSource' could not be written to $guardScript ($copyError); the boot task would run bytes the payload never shipped"
    }
  } elseif ($guardSource) {
    # THE COMMON RE-ENTRY: nothing is written, and the row says so - "already
    # current" is a measured fact (both hashes present and equal), not a guess.
    $guardState = 'already current'
    Say "relay guard: already current (sha256=$stagedHash); not rewriting $guardScript"
  } elseif ($stagedPresent) {
    # A re-run after the payload directory is gone: the staged copy is what the
    # boot task already names, so keep it and say which hash is in place.
    $guardState = 'kept'
    Say "relay guard: no staged copy found; keeping the existing $guardScript (sha256=$stagedHash)"
  } else {
    throw 'cua-relay-guard.ps1 is in neither the OEM payload nor C:\ProgramData\cua; the boot guard would be a task that does nothing'
  }

  # NO NESTED QUOTES IN /tr: C:\ProgramData\cua is a path with no spaces, so the
  # -File argument needs none - and avoiding them is the entire reason the relay's
  # command lives in a .vbs instead of in /tr (a nested quote there silently
  # truncates the action). -Port is written into the action so the FIRST run after
  # provisioning probes the port this pass used (a task has no environment).
  #
  # -Port IS A FALLBACK, NOT THE TRUTH. The guard prefers the port it reads out of
  # C:\ProgramData\cua\mcp-relay-host.vbs, because that file is the one the harness
  # can still repair after provisioning (`--serve --port <port>`) and the port a
  # relay actually listens on is whatever its launcher starts it with. This value
  # covers the first pass (no launcher yet, or a launcher from an older payload
  # that says bare `--serve`); from then on the launcher is self-correcting, so a
  # later harness repair cannot leave this baked number probing a dead port.
  $guardTr = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $guardScript -Boot -Port $relayPort"
  $guardCmd = Join-Path $env:TEMP 'cua-relay-guard-task.cmd'
  @("schtasks /create /tn `"cua-mcp-host-guard`" /sc onstart /ru SYSTEM /rl HIGHEST /f /tr `"$guardTr`"") |
    Set-Content -Path $guardCmd -Encoding ASCII
  & cmd /c $guardCmd
  $guardExit = $LASTEXITCODE
  Remove-Item -Force $guardCmd -ErrorAction SilentlyContinue
  if ($guardExit -ne 0) { throw "schtasks could not register cua-mcp-host-guard (exit $guardExit)" }

  # IDENTITY (P3): the guest records WHICH guard it registered. The boot guard is
  # the one component that repairs the lane when nobody is watching, so "the guard
  # is stale" must be visible from the marker rather than inferred from behaviour.
  $guardHash = ''
  try { $guardHash = (Get-FileHash -LiteralPath $guardScript -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $guardHash = '' }
  Say "relay guard registered (cua-mcp-host-guard: onstart, SYSTEM, /rl HIGHEST) -> $guardScript sha256=$guardHash ($guardState)"
  # `guardSha256` is the EFFECTIVE hash on disk (source when this pass copied,
  # staged when it kept what was there) - the number the harness compares against
  # `expectedGuardHash`, not this payload's idea of what it should be.
  return @{ guardSha256 = $guardHash; guardState = $guardState }
}

# THE SESSION-0 DEFECT, FIXED AT ITS ROOT.
#
# THE OBSERVED FAILURE: the MCP server the harness starts over SSH runs in the
# SSH SERVICE's session - Session 0 - and UIA is per-session. From there
# `list_windows` returns ZERO windows, and a notepad started by a tool is created
# "in Services": invisible to the logged-on user, unfindable by the next call.
# The transport was never the problem; the session was.
#
# THE FIX: a loopback TCP <-> stdio relay. `python -m dsh_cua.server --stdio`
# still speaks MCP on its stdio, but it is started by THIS task, in the
# INTERACTIVE session, and its stdio is bridged to 127.0.0.1:47999 by
# C:\ProgramData\cua\mcp-relay.py --serve. The SSH side runs
# `mcp-relay.py --connect`, which touches no desktop and simply moves bytes
# between the SSH channel's stdio and that socket. win-mcp.js keeps its stdio
# contract; only the command it runs changes (python ... --connect), so none of
# the SSH/transport code moves.
#
# /it IS THE ENTIRE POINT: without it the task would run in Session 0 again and
# the relay would faithfully forward JSON-RPC to a server that still cannot see
# a single window. /rl LIMITED = the user's own token, so the relay runs on the
# same desktop (and at the same integrity level) as the windows it drives.
#
# WHY A 127.0.0.1 LISTENER IS NOT AN ATTACK SURFACE WORTH ARGUING ABOUT: the
# relay binds loopback only. Reaching it already means code running on this
# guest, which can start its own dsh_cua.server anyway.
Step 'mcp-relay-task' {
  New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua' | Out-Null
  $relayScript = 'C:\ProgramData\cua\mcp-relay.py'

  # WP-1A - ADOPT, DO NOT OVERWRITE. This step rewrites the launcher below, so the
  # port it writes decides where the relay listens. On a re-entry the launcher may
  # already name a port the HARNESS repaired (`--serve --port <n>`) while this
  # script's value comes from the environment or the 47999 default; writing the
  # latter would undo the repair and leave the guard probing a port nothing
  # listens on. So the launcher wins when it names a legal port, and the read
  # happens HERE - before the port is used anywhere in this step (the value below must come after it, which is what the gate's S12 reads).
  $launcherPort = Get-RelayLauncherPort -LauncherPath 'C:\ProgramData\cua\mcp-relay-host.vbs'
  if ($launcherPort) {
    $script:relayPort = $launcherPort
    Say "mcp relay: launcher names --port $launcherPort; adopting it instead of re-resolving (a harness repair must survive a provisioning pass)"
  }

  # THE BODY COMES FROM THE OEM PAYLOAD, searched exactly where
  # cua-clip-agent.ps1 is searched: $PSScriptRoot (Setup\Scripts), the setup.img
  # ROOT (the removable roots C:..H: the fallback boot path uses) and a copy an
  # operator already put in place.
  $relaySource = $null
  $relayDirs = @($PSScriptRoot, 'C:\Windows\Setup\Scripts', 'C:\', 'D:\', 'E:\', 'F:\', 'G:\', 'H:\')
  foreach ($relayDir in $relayDirs) {
    if (-not $relayDir) { continue }
    $relayCandidate = Join-Path $relayDir 'cua-mcp-relay.py'
    if (Test-Path -LiteralPath $relayCandidate -ErrorAction SilentlyContinue) { $relaySource = $relayCandidate; break }
  }
  if ($relaySource) {
    Copy-Item -LiteralPath $relaySource -Destination $relayScript -Force
    Say "mcp relay: $relaySource -> $relayScript"
  } elseif (Test-Path -LiteralPath $relayScript) {
    # A re-run after the payload directory is gone: the script in ProgramData is
    # still the same bytes, so keep it rather than registering a task that
    # points at nothing.
    Say "mcp relay: no staged copy found; keeping the existing $relayScript"
  } else {
    # A TASK WHOSE -File POINTS AT NOTHING "STARTS" AND DOES NOTHING - the
    # failure mode this repository keeps naming. Fail the step instead.
    throw 'cua-mcp-relay.py is in neither the OEM payload nor C:\ProgramData\cua; the relay would be a task that does nothing'
  }

  # THE INTERPRETER: the same real-python rule the provisioning steps use (no
  # WindowsApps App Execution Alias), plus the `py -3` launcher as a second
  # chance, which is the documented way to ask Windows for ITS python when PATH
  # does not carry one yet (a firstboot that ran before a logoff).
  $py = Get-RealPython
  if (-not $py) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher -and $launcher.Source) {
      try {
        $candidate = (& $launcher.Source -3 -c "import sys;print(sys.executable)" 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $candidate) {
          $candidate = ([string]$candidate).Trim()
          if ($candidate -and $candidate -notmatch '\\WindowsApps\\' -and (Test-Path -LiteralPath $candidate)) { $py = $candidate }
        }
      } catch { $py = $null }
    }
  }
  if (-not $py) { throw 'python is missing: cannot register the mcp relay' }

  # WINDOWLESS, LIKE dsh-cua-server. python.exe ALWAYS allocates a console, and
  # this task runs with /it - so the console would appear on the user's desktop
  # as a permanently blank window (the U3 defect). pythonw.exe ships beside
  # python.exe; an unusual layout falls back to python.exe, which at least keeps
  # the relay working.
  $relayPy = $py
  $relayPyw = Join-Path (Split-Path -Parent $py) 'pythonw.exe'
  if (Test-Path -LiteralPath $relayPyw) { $relayPy = $relayPyw }

  # THE PORT IS RESOLVED ONCE, AT THE TOP OF THIS SCRIPT (Resolve-RelayPort), and
  # every consumer reads that one value: the launcher here, the guard task's -Port,
  # and the -Ensure calls. A second resolution in this step is how the launcher and
  # the probe could end up naming different ports.
  #
  # AND THE LAUNCHER IS A CONSUMER IN FACT, NOT ONLY IN THIS COMMENT: the command
  # below carries `--port $relayPort`. A bare `--serve` lets the relay fall back to
  # its own default (47999) or to whatever a logon session happens to carry, while
  # the guard probes the resolved number - the two agree only by luck, and this
  # step rewrites the launcher on EVERY run, so a bare command here would undo the
  # harness's repair (`--serve --port <harness port>`) and re-open the port split
  # at the next provisioning pass.

  # THE COMMAND THE TASK MUST RUN (quoted, because python.org installs to
  # "C:\Program Files\Python3xx\..."). This is the line that ends up in the
  # launcher below, and the launcher is what /tr names.
  $relayCommand = "`"$relayPy`" `"$relayScript`" --serve --port $relayPort"

  # WHY A LAUNCHER AND NOT THE COMMAND IN /tr DIRECTLY:
  #   `schtasks /tr` is ONE command line that Windows RE-PARSES, and the repo
  #   already documents that a nested quote there silently truncates the action
  #   (a task that exists and does nothing). With the interpreter under
  #   "C:\Program Files" the generated line is
  #       /tr ""C:\Program Files\Python311\pythonw.exe" C:\...\mcp-relay.py --serve"
  #   - doubled quotes that no two parsers agree on. Rather than depend on which
  #   one wins, the quoting lives in a file that is NOT re-parsed, and /tr names
  #   that file: a path with NO spaces and therefore no quotes inside /tr.
  #
  # WHY wscript.exe: a .cmd launcher would flash a console window on the very
  # desktop this task exists to automate (cmd.exe is a console process); wscript
  # is GUI-subsystem and `Run ..., 0, False` starts the relay hidden. Same
  # trick as Unattend.vbs, the image's existing hidden launcher.
  $relayLauncher = 'C:\ProgramData\cua\mcp-relay-host.vbs'
  # `--port <n>` STAYS IMMEDIATELY BEFORE THE CLOSING QUOTE, exactly as the guard's
  # New-RelayLauncher and the harness's repair (`win-mcp.js`, which recognises its
  # own work by `'--port ' + $port + '"'`) write it: anything else is a launcher
  # the host will rewrite on the next attach, and a repair loop is a worse defect
  # than the divergence it was meant to close.
  $relayRunLine = 'shell.Run """' + $relayPy + '"" ""' + $relayScript + '"" --serve --port ' + [string]$relayPort + '", 0, False'
  Set-Content -Path $relayLauncher -Encoding ASCII -Value @(
    "' cua-mcp-host: start the interactive-session MCP relay, hidden, no console.",
    "' Written by cua-firstboot.ps1 (step mcp-relay-task); regenerated on every run.",
    "' The command lives here because schtasks /tr cannot carry nested quotes:",
    # PARENTHESISED ON PURPOSE: inside @( ) the comma binds TIGHTER than +,
    # so an unparenthesised `"'   " + $x` silently becomes TWO array items -
    # the comment and the command on separate lines, which would turn the
    # command line into a VBS statement and break the launcher.
    ("'   " + $relayCommand),
    'Set shell = CreateObject("WScript.Shell")',
    $relayRunLine
  )

  # THROUGH A .cmd FILE for the reason the clipboard tasks document: Windows
  # PowerShell 5.1 hands a variable containing spaces to a native program
  # UNQUOTED, so `& schtasks /tr $relayTr` would arrive as `/tr wscript.exe
  # //B ...` and schtasks would take only the first token as the action. cmd
  # parses the quoted argument the documented way.
  #
  # /sc onlogon + /it: AT LOGON, IN THE INTERACTIVE SESSION - the one session
  # whose desktop UIA can see. /rl LIMITED: the user's own token, same desktop,
  # same integrity level as the windows the MCP server will drive.
  #
  # /ru "<account>" IS THE FIX, AND IT IS NOT A DETAIL. WITHOUT it the task binds
  # to the CALLER - the computer account in the SYSTEM pass - and `/it` is
  # meaningless for a machine principal, so Task Scheduler refuses the create with
  # exit 1 (reproduced: the marker's mcp-relay-task ok:false "exit 1" at 12:33:06,
  # then ok:true at 12:35:41 from the logon pass, where /ru was implicitly the
  # logged-on user). With /ru the SAME command succeeds from Session 0 - measured
  # over SSH: SUCCESS, "Run As User: cua", "Logon Mode: Interactive only", exit 0.
  # $relayAccount was resolved once, above, and asserted with Get-LocalUser.
  if (-not $relayAccount) {
    throw 'no local account could be resolved for /ru (Get-LocalUser/net user found none); /it without /ru is refused from Session 0'
  }
  $relayTr = "wscript.exe //B //NoLogo $relayLauncher"
  $relayCmd = Join-Path $env:TEMP 'cua-mcp-relay-task.cmd'
  @("schtasks /create /tn `"cua-mcp-host`" /sc onlogon /ru `"$relayAccount`" /it /rl LIMITED /f /tr `"$relayTr`"") |
    Set-Content -Path $relayCmd -Encoding ASCII
  & cmd /c $relayCmd
  $relayExit = $LASTEXITCODE
  Remove-Item -Force $relayCmd -ErrorAction SilentlyContinue
  if ($relayExit -ne 0) {
    # A FAILURE HERE MUST STAY SELF-HEALING, NOT TERMINAL. It throws, so the step
    # records ok:false - and $done only ever holds ok:true, so the NEXT firstboot
    # pass retries it. It also leaves the cua-mcp-host-guard task registered (the
    # step above runs first and does not depend on this one), so a guest that
    # failed in BOTH passes is repaired at the next boot instead of staying blind
    # until somebody notices.
    throw "schtasks could not register cua-mcp-host (exit $relayExit); the cua-mcp-host-guard task will retry at boot"
  }

  # "IS IT UP" HAS EXACTLY ONE IMPLEMENTATION, AND IT IS NOT IN THIS FILE.
  #
  # This used to carry a TcpClient probe plus a 20 x 500 ms wait of its own - the
  # copy that twice read nine bytes for an eight-byte answer, said "down" against a
  # healthy relay, and made every run start a SECOND listener (WinError 10048).
  # The guard owns the probe and the wait now: -Ensure probes first, starts the
  # task only when the port is silent, and waits up to the budget below. The boot
  # guard runs the same file with -Boot, so firstboot and boot time cannot
  # disagree about what "up" means.
  $guardPath = Find-RelayGuardPath
  if (-not $guardPath) {
    throw 'relay-guard-missing: cua-relay-guard.ps1 is in neither the OEM payload nor C:\ProgramData\cua, so the relay cannot be verified'
  }
  $guardResult = Invoke-RelayGuard -GuardPath $guardPath -Mode 'Ensure' -Port $relayPort -Account $relayAccount -WaitSeconds 10
  Say "mcp relay: guard -Ensure exit $($guardResult.exit): $($guardResult.record)"
  if ($guardResult.exit -eq 0) {
    Say "mcp relay registered (cua-mcp-host: onlogon, INTERACTIVE, /rl LIMITED) and answering on 127.0.0.1:$relayPort as $relayPy"
  } elseif (Test-SystemPass) {
    # THE SYSTEM PASS CANNOT PROVE A LISTENER, AND MUST NOT PRETEND IT DID.
    # An InteractiveToken task cannot run before anyone logs on, so a negative
    # probe in setupcomplete.cmd is EXPECTED: what this pass can prove - and does -
    # is that the task is registered against the right account with the right
    # trigger. The interactive pass re-asserts the lane (mcp-relay-reassert), and
    # the boot guard repairs it from then on. Reported as an annotation so the
    # marker says which of the two failures this is.
    Say "mcp relay: registered for '$relayAccount'; no interactive session exists in the SYSTEM pass, so the listener is proven at logon"
    return @{ relay = 'registered-session-0'; guardExit = $guardResult.exit }
  } else {
    throw 'task-started-but-relay-not-listening'
  }
}

# THE STEP THAT IS NEVER SKIPPED.
#
# Every other step is gated by `$done`, which only holds ok:true - correct for
# installing OpenSSH, wrong for the lane: the relay can be dead (killed, crashed,
# an onlogon task that never fired) while the marker still reads ok:true from the
# pass that installed it, and nothing else runs firstboot twice. This step runs on
# EVERY invocation and asks the same guard the boot task runs to make the relay
# answer, so any later firstboot pass repairs the lane instead of reporting a
# stale success.
#
# WHICH ANSWER IS A REAL FAILURE: in the SYSTEM pass an InteractiveToken task
# cannot start at all, so "not answering" there is expected and recorded as an
# annotation - a step that is permanently ok:false would hide a real failure. In
# the interactive pass the same answer throws, which keeps the step retryable.
Step 'mcp-relay-reassert' {
  $guardPath = Find-RelayGuardPath
  if (-not $guardPath) {
    throw 'relay-guard-missing: cua-relay-guard.ps1 is in neither the OEM payload nor C:\ProgramData\cua, so the relay cannot be re-asserted'
  }
  $guardResult = Invoke-RelayGuard -GuardPath $guardPath -Mode 'Ensure' -Port $relayPort -Account $relayAccount -WaitSeconds 10
  Say "mcp relay re-assert: guard -Ensure exit $($guardResult.exit): $($guardResult.record)"
  if ($guardResult.exit -eq 0) { return @{ reassert = 'up' } }
  if (Test-SystemPass) {
    return @{ reassert = 'skipped'; reason = 'no-interactive-session' }
  }
  throw "mcp-relay-reassert: the relay is still not answering after -Ensure (exit $($guardResult.exit))"
} -Always

# WP-1A - ONE TOP-LEVEL FIELD FOR "IS THE GUARD STALE". The hash is READ BACK from
# the row the step wrote rather than recomputed here, so the summary and the step
# cannot disagree: if the step was skipped by the marker (a previous pass already
# ok:true) the row still carries the hash that pass measured.
$guardRow = @($state.steps | Where-Object { $_.step -eq 'relay-guard-task' } | Select-Object -Last 1)
$state.guardSha256 = if ($guardRow.Count -gt 0 -and $guardRow[0].guardSha256) { [string]$guardRow[0].guardSha256 } else { '' }

$state.finished = (Get-Date).ToString('o')
$state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
Say 'DONE'
