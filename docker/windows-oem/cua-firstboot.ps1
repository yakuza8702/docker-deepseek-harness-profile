<#
  cua-firstboot.ps1 - everything a fresh Windows computer needs to be usable by
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
# A `skipped` entry is ok:true but NOT done: the privacy off-switch (J20-1b) is
# re-checked on every run, so removing the sentinel registers and starts the
# task without needing -Force (and while it is there, nothing is registered).
foreach ($step in $state.steps) { if ($step.ok -eq $true -and $step.skipped -ne $true) { $done[$step.step] = $true } }
if ($Force) { $done = @{}; $state.steps = @() }

function Step([string]$name, [scriptblock]$body) {
  if ($done.ContainsKey($name)) { Say "== $name (already done, skipped)"; return }
  Say "== $name"
  try {
    $result = & $body
    $entry = @{ step = $name; ok = $true }
    # A BODY MAY ANNOTATE ITS OWN MARKER ENTRY by returning a hashtable. The
    # clip-agent step uses it to record `skipped = $true; reason =
    # 'clip-agent-disabled'` when the privacy off-switch sentinel exists: a bare
    # ok:true there would read as "the task was registered", which is the exact
    # lie the switch exists to prevent.
    #
    # SEARCHED, NOT TESTED ON $result: a body that logged with Say before
    # returning its hashtable hands back an ARRAY of strings and hashtables, and
    # `$result -is [hashtable]` would be false - the skip annotation would vanish
    # into a plain ok:true, which is the defect all over again.
    $annotation = @($result | Where-Object { $_ -is [hashtable] } | Select-Object -First 1)
    if ($annotation.Count -gt 0) {
      foreach ($key in $annotation[0].Keys) { $entry[$key] = $annotation[0][$key] }
    }
    $state.steps += $entry
  } catch {
    Say "FAILED $name : $($_.Exception.Message)"
    $state.steps += @{ step = $name; ok = $false; error = $_.Exception.Message }
  }
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

# THE ONLY LOCAL PROOF THAT THE MCP RELAY IS LISTENING (same idea as J22-13
# above, for a process that publishes no file). The relay answers a connection
# whose first bytes are RELAY_PING with RELAY_OK and closes it, BEFORE it touches
# a child, so this probe is safe to run against a relay that is mid-session.
#
# TcpClient has no connect timeout of its own: BeginConnect + WaitOne is the
# documented way to bound it, otherwise a host where the port is filtered (rather
# than refused) makes firstboot hang instead of failing the step.
function Test-RelayPing([int]$Port, [int]$TimeoutMs = 800) {
  $client = $null
  # ONE DEADLINE FOR THE WHOLE PROBE, tracked by a stopwatch instead of handed to
  # each Read: a stream timeout is per-read, so N late bytes would otherwise buy
  # N x $TimeoutMs of stall inside a check whose contract is 800 ms total.
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($pending)
    $client.ReceiveTimeout = $TimeoutMs
    $stream = $client.GetStream()
    $probe = [System.Text.Encoding]::ASCII.GetBytes('RELAY_PING')
    $stream.Write($probe, 0, $probe.Length)
    $stream.Flush()
    # RELAY_OK IS EIGHT BYTES ("R","E","L","A","Y","_","O","K"). A 9-byte
    # buffer here read one byte too many and compared a short read against the
    # wrong length - which made this probe answer $false EVERY time, i.e. the
    # idempotency check below would never fire and every run would start a
    # second listener. The length is asserted, not assumed.
    #
    # AND ONE Read IS NOT THE ANSWER. RELAY_OK is "eight bytes" on the WIRE, not
    # "eight bytes in one syscall": TCP is a byte stream, so a legal short read
    # (the relay's sendall landing in two segments, a loopback/NIC oddity, a
    # Winsock buffer that has 3 of 8 bytes when the read is issued) is NOT a
    # failure - and treating it as one made this probe answer $false against a
    # relay that was perfectly healthy. That false negative lands on the same
    # /run path as a real outage: the next firstboot starts a SECOND relay, which
    # loses the bind with WinError 10048 (the two-relays-on-one-port defect this
    # whole function exists to prevent). So ACCUMULATE until 8 bytes or EOF, and
    # let the shared stopwatch bound the loop.
    $answer = New-Object byte[] 8
    $read = 0
    while ($read -lt $answer.Length) {
      $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
      if ($remaining -le 0) { return $false }
      $client.ReceiveTimeout = $remaining
      $got = $stream.Read($answer, $read, $answer.Length - $read)
      # 0 means the peer closed: EOF before 8 bytes is a truncated answer, and a
      # truncated answer is not RELAY_OK. Stop here rather than spin.
      if ($got -le 0) { break }
      $read += $got
    }
    if ($read -ne 8) { return $false }
    return ([System.Text.Encoding]::ASCII.GetString($answer) -ceq 'RELAY_OK')
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
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

  $relayPort = 47999
  if ($env:DSH_CUA_MCP_RELAY_PORT) {
    $parsedPort = 0
    if ([int]::TryParse($env:DSH_CUA_MCP_RELAY_PORT, [ref]$parsedPort) -and $parsedPort -gt 0 -and $parsedPort -lt 65536) { $relayPort = $parsedPort }
  }

  # THE COMMAND THE TASK MUST RUN (quoted, because python.org installs to
  # "C:\Program Files\Python3xx\..."). This is the line that ends up in the
  # launcher below, and the launcher is what /tr names.
  $relayCommand = "`"$relayPy`" `"$relayScript`" --serve"

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
  $relayRunLine = 'shell.Run """' + $relayPy + '"" ""' + $relayScript + '"" --serve", 0, False'
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
  $relayTr = "wscript.exe //B //NoLogo $relayLauncher"
  $relayCmd = Join-Path $env:TEMP 'cua-mcp-relay-task.cmd'
  @("schtasks /create /tn `"cua-mcp-host`" /sc onlogon /it /rl LIMITED /f /tr `"$relayTr`"") |
    Set-Content -Path $relayCmd -Encoding ASCII
  & cmd /c $relayCmd
  $relayExit = $LASTEXITCODE
  Remove-Item -Force $relayCmd -ErrorAction SilentlyContinue
  if ($relayExit -ne 0) { throw "schtasks could not register cua-mcp-host (exit $relayExit)" }

  # IDEMPOTENT: THE PORT IS THE EVIDENCE. If it already answers RELAY_PING the
  # relay is up (started at logon, or by an earlier firstboot) and a /run here
  # would race it for the bind - the loser dies with WinError 10048 while the
  # marker still reads ok:true. Starting nothing is the correct outcome.
  if (Test-RelayPing $relayPort) {
    Say "mcp relay: already answering RELAY_PING on 127.0.0.1:$relayPort; not started again"
  } else {
    & schtasks /run /tn 'cua-mcp-host' | Out-Null
    $relayRun = $LASTEXITCODE
    if ($relayRun -ne 0) { throw "schtasks could not start cua-mcp-host (exit $relayRun)" }
    # schtasks /run proves ACCEPTANCE, not a listener (J22-13's lesson). Poll the
    # probe: 20 x 500 ms covers a cold pythonw.exe plus the import of dsh_cua.
    $relayUp = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      Start-Sleep -Milliseconds 500
      if (Test-RelayPing $relayPort) { $relayUp = $true; break }
    }
    if (-not $relayUp) { throw 'task-started-but-relay-not-listening' }
  }
  Say "mcp relay registered (cua-mcp-host: onlogon, INTERACTIVE, /rl LIMITED) and answering on 127.0.0.1:$relayPort as $relayPy"
}

$state.finished = (Get-Date).ToString('o')
$state | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $marker
Say 'DONE'
