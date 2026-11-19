<#
  cua-relay-guard.ps1 - ONE owner for "the interactive MCP relay is up".

  WHY THIS FILE EXISTS
  --------------------
  Two places need the same answer - "is C:\ProgramData\cua\mcp-relay.py
  listening on 127.0.0.1:<port>, and does it answer RELAY_PING?" - and both used
  to answer it with their own copy of a probe:

    * cua-firstboot.ps1, right after it registers cua-mcp-host (step
      mcp-relay-task), to prove the listener before it writes ok:true;
    * anything that must repair the lane later, when no firstboot run happens at
      all (a reboot whose onlogon task did not fire, a relay that was killed).

  TWO COPIES IS HOW THE NINE-BYTE DEFECT HAPPENED TWICE: a probe that read 9
  bytes compared a short read against the wrong length and answered "down"
  against a perfectly healthy relay - so every firstboot run started a SECOND
  listener and the loser died with WinError 10048 while the marker still said
  ok:true. This file is the single copy of that probe. cua-firstboot.ps1 calls it
  with -Ensure instead of carrying socket code of its own, and the boot guard
  registered as cua-mcp-host-guard calls it with -Boot.

  MODES (precedence: -Ensure, then -Autologon, else -Boot, the default)
  ----------------------------------------------------------------------
    -Ensure      "make it answer now, if you can". Probe; when the port is down,
                 rebuild a missing launcher or task, run the task, wait up to
                 -WaitSeconds (default 10 = the 20 x 500 ms wait firstboot used
                 to spin), then probe again. No autologon change, no session
                 wait: the caller is an install path that must not block on a
                 desktop.
    -Autologon   re-assert HKLM\...\Winlogon\AutoAdminLogon when it is missing or
                 0, and fill DefaultUserName when it is missing (an operator's
                 value is never overwritten). Exit 0 iff AutoAdminLogon is 1.
    -Boot        the boot guard (/sc onstart, SYSTEM): autologon re-assert,
                 HANDSHAKE FIRST, wait up to 90 s for an Active console session,
                 rebuild/register what is missing, run the task only when the
                 port is still down, verify, one line.

  IT NEVER STARTS A SECOND LISTENER. Every path probes before it runs the task
  and runs the task only when the probe is down - the 10048 lesson, applied to
  the copy that runs unattended at boot.

  THE PORT COMES FROM THE LAUNCHER, NOT FROM THE TASK ACTION
  ----------------------------------------------------------
  The boot task carries `-Port <the port firstboot resolved>`, and that is only a
  FALLBACK. The relay's real port is whatever its launcher starts it on, and the
  launcher is the one file the harness can still repair after provisioning
  (plugins/dsh-cua-vm/win-mcp.js rewrites mcp-relay-host.vbs to say
  `--serve --port <the port it probes>`). Preferring the baked task argument is
  how the divergence re-opened on EVERY boot: the guard probed the provision-time
  port, waited the whole 90 s, then ran the task while the relay was answering on
  the harness's port - a /run against a live relay, WinError 10048 in the event
  log, and a record that said ok=0 with the lane perfectly healthy.
  So -Boot and -Ensure read the port back out of the launcher when it has one
  (Get-LauncherPort), and every launcher THIS file writes carries its port, so a
  rebuilt launcher can never re-create the split it was meant to close.

  EXIT CODES (nothing else, so a caller can branch on them)
  --------------------------------------------------------
    0  -Ensure / -Boot: the handshake answered RELAY_OK at the end of this run.
    0  -Autologon:      AutoAdminLogon is 1 (and a user could be resolved).
    1  otherwise.

  ONE LOG LINE, ALWAYS
  --------------------
  Appended to C:\ProgramData\cua\relay-guard.log and printed on stdout, so
  cua-firstboot.ps1 can copy the same verdict into C:\cua-provision.json. The key
  grammar follows the harness repair record (Appendix B of the SOL): space-
  separated key=value, ok=1 only when the handshake answered.

  THIS FILE IS ASCII ONLY. It is staged to a guest whose console may use any
  code page, is read by Windows PowerShell 5.1, and is diffed against the copy in
  docker/windows-oem/, so a stray non-ASCII character is a real defect.
#>
param(
  [switch]$Ensure,
  [switch]$Autologon,
  [switch]$Boot,
  # THE FALLBACK PORT, in precedence order: the launcher's --port wins when it
  # has one (it is the file the harness repairs), then this value, then
  # DSH_CUA_MCP_RELAY_PORT, then 47999 (the relay's default).
  [int]$Port = 0,
  # The interactive account. Empty = the console session's user, else Winlogon's
  # DefaultUserName, else the 'cua' local account (see Resolve-RelayAccount).
  [string]$User = '',
  # 0 = the mode default (Boot 90 s for the session, Ensure 10 s for the start).
  [int]$WaitSeconds = 0,
  [int]$ProbeTimeoutMs = 800
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

$Dir = 'C:\ProgramData\cua'
# CONCATENATION, NOT Join-Path: these are fixed literal Windows paths, and
# Join-Path resolves them through the FileSystem provider (drive lookup), which
# buys nothing here and makes the file unrunnable outside Windows - the smoke test
# in the PR runs it on Linux with a fake root, and a $null path there would hide
# every branch behind an "empty path" error instead of exercising it.
$RelayScript = $Dir + '\mcp-relay.py'
$Launcher = $Dir + '\mcp-relay-host.vbs'
$TaskName = 'cua-mcp-host'
$LogPath = $Dir + '\relay-guard.log'
$WinlogonKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

# ---------------------------------------------------------------------------
# THE PROBE - the one copy. Relocated verbatim from cua-firstboot.ps1, comments
# included, because those comments are the defect history that keeps it correct.
# ---------------------------------------------------------------------------

# THE ONLY LOCAL PROOF THAT THE MCP RELAY IS LISTENING. The relay answers a
# connection whose first bytes are RELAY_PING with RELAY_OK and closes it, BEFORE
# it touches a child, so this probe is safe to run against a relay that is
# mid-session.
#
# TcpClient has no connect timeout of its own: BeginConnect + WaitOne is the
# documented way to bound it, otherwise a host where the port is filtered (rather
# than refused) makes the caller hang instead of failing the step.
#
# IT RETURNS THE TOKEN, NOT A BOOLEAN, because the log line has to say WHAT
# answered: '' (nothing), RELAY_OK, or anything else the peer sent. A boolean
# would erase the difference between "no listener" and "a listener that is not
# our relay", which is exactly the payload-skew question.
function Get-RelayAnswer([int]$Port, [int]$TimeoutMs = 800) {
  $client = $null
  # ONE DEADLINE FOR THE WHOLE PROBE, tracked by a stopwatch instead of handed to
  # each Read: a stream timeout is per-read, so N late bytes would otherwise buy
  # N x $TimeoutMs of stall inside a check whose contract is 800 ms total.
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMs)) { return '' }
    $client.EndConnect($pending)
    $client.ReceiveTimeout = $TimeoutMs
    $stream = $client.GetStream()
    $probe = [System.Text.Encoding]::ASCII.GetBytes('RELAY_PING')
    $stream.Write($probe, 0, $probe.Length)
    $stream.Flush()
    # RELAY_OK IS EIGHT BYTES ("R","E","L","A","Y","_","O","K"). A 9-byte
    # buffer here read one byte too many and compared a short read against the
    # wrong length - which made this probe answer "down" EVERY time, i.e. the
    # idempotency check would never fire and every run would start a second
    # listener. The length is asserted, not assumed.
    #
    # AND ONE Read IS NOT THE ANSWER. RELAY_OK is "eight bytes" on the WIRE, not
    # "eight bytes in one syscall": TCP is a byte stream, so a legal short read
    # (the relay's sendall landing in two segments, a loopback/NIC oddity, a
    # Winsock buffer that has 3 of 8 bytes when the read is issued) is NOT a
    # failure - and treating it as one answers "down" against a relay that is
    # perfectly healthy. That false negative lands on the same /run path as a
    # real outage: the next run starts a SECOND relay, which loses the bind with
    # WinError 10048. So ACCUMULATE until 8 bytes or EOF, and let the shared
    # stopwatch bound the loop.
    $answer = New-Object byte[] 8
    $read = 0
    while ($read -lt $answer.Length) {
      $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
      if ($remaining -le 0) { return '' }
      $client.ReceiveTimeout = $remaining
      $got = $stream.Read($answer, $read, $answer.Length - $read)
      # 0 means the peer closed: EOF before 8 bytes is a truncated answer, and a
      # truncated answer is not RELAY_OK. Stop here rather than spin.
      if ($got -le 0) { break }
      $read += $got
    }
    if ($read -ne 8) { return '' }
    return [System.Text.Encoding]::ASCII.GetString($answer)
  } catch {
    return ''
  } finally {
    if ($client) { $client.Close() }
  }
}

# The boolean form, for the callers whose question really is yes/no.
function Test-RelayPing([int]$Port, [int]$TimeoutMs = 800) {
  return ((Get-RelayAnswer -Port $Port -TimeoutMs $TimeoutMs) -ceq 'RELAY_OK')
}

# Wait for the relay to answer, without ever exceeding $Seconds of wall clock.
# Returns the LAST token seen ('' when nothing answered), so the record says what
# the wait actually observed rather than just "timed out".
function Wait-Relay([int]$Port, [int]$Seconds, [int]$TimeoutMs) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $answer = ''
  while ((Get-Date) -lt $deadline) {
    $answer = Get-RelayAnswer -Port $Port -TimeoutMs $TimeoutMs
    if ($answer -ceq 'RELAY_OK') { return $answer }
    Start-Sleep -Milliseconds 500
  }
  return (Get-RelayAnswer -Port $Port -TimeoutMs $TimeoutMs)
}

# ---------------------------------------------------------------------------
# WHO AND WHERE - resolved, never guessed from %USERNAME%
# ---------------------------------------------------------------------------

# %USERNAME% IS NOT AN ANSWER HERE.
#   * under the boot guard it is whatever the task runs as (SYSTEM), not the user
#     whose desktop the relay must live in;
#   * in the SYSTEM pass of firstboot it is the COMPUTER account (NAME$), a
#     principal that cannot own an interactive token at all;
#   * in firstboot's logon pass it happens to be right, which is exactly why the
#     bug was invisible there - /it without the right /ru is refused from
#     Session 0 (schtasks exit 1), and that is the failure this fixes.
# The order below asks the GUEST who it actually has: the account that owns the
# console session (the desktop this relay must drive), then the account Winlogon
# will auto-logon, then the literal account the answer file provisions, then a
# single enabled non-builtin local account. Get-LocalUser is the assertion: a
# name that is not a real, enabled local user is never used.
function Resolve-RelayAccount([string]$Explicit) {
  if ($Explicit) { return $Explicit }
  $candidates = @()
  $session = Get-ConsoleSession -Account ''
  if ($session.user) { $candidates += $session.user }
  try {
    $default = (Get-ItemProperty -LiteralPath $WinlogonKey -Name DefaultUserName -ErrorAction Stop).DefaultUserName
    if ($default) { $candidates += [string]$default }
  } catch { }
  $candidates += 'cua'
  foreach ($name in $candidates) {
    $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($user -and $user.Enabled) { return [string]$user.Name }
  }
  $local = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -and $_.Name -ne 'Administrator' -and $_.Name -ne 'Guest' })
  if ($local.Count -eq 1) { return [string]$local[0].Name }
  return ''
}

# THE CONSOLE SESSION, the only desktop a VNC viewer can see and the only one
# the relay must run in. Parsed from `query session` because that is the one
# surface available to SYSTEM at boot with no desktop of its own.
#
# COLUMNS ARE THE CONTRACT: SESSIONNAME, USERNAME, ID, STATE. `query session`
# marks the CURRENT session with a leading '>' and pads with two or more spaces,
# so the split is on runs of whitespace - a single-space split would shear a name
# that contains a space. A logged-off machine prints the console row with no
# USERNAME (three fields); that row is not a session yet and is skipped.
#
# STATE IS MATCHED ON '^Act' DELIBERATELY: the English word is what the shipping
# images print, and a localized image (Aktiv, Actif) can only ever make this wait
# longer, never start a second listener - the run below is still gated on a
# negative probe, and the handshake decides the exit code.
function Get-ConsoleSession([string]$Account) {
  $result = @{ id = 0; user = '' }
  $lines = @()
  try { $lines = @(& query.exe session 2>$null) } catch { return $result }
  foreach ($line in $lines) {
    $text = ([string]$line).Trim()
    if (-not $text) { continue }
    if ($text.StartsWith('>')) { $text = $text.Substring(1).Trim() }
    $fields = @($text -split '\s{2,}')
    if ($fields.Count -lt 4) { continue }
    if ($fields[0] -ne 'console') { continue }
    if ($fields[3] -notmatch '^Act') { continue }
    $sessionId = 0
    if (-not [int]::TryParse([string]$fields[2], [ref]$sessionId)) { continue }
    if ($Account -and ([string]$fields[1] -ne $Account)) { continue }
    $result.id = $sessionId
    $result.user = [string]$fields[1]
    return $result
  }
  return $result
}

function Resolve-Port([int]$Value) {
  if ($Value -gt 0 -and $Value -lt 65536) { return $Value }
  $envPort = 0
  if ([int]::TryParse([string]$env:DSH_CUA_MCP_RELAY_PORT, [ref]$envPort) -and $envPort -gt 0 -and $envPort -lt 65536) { return $envPort }
  return 47999
}

# ---------------------------------------------------------------------------
# WHAT TO REBUILD - launcher, task, run
# ---------------------------------------------------------------------------

# THE INTERPRETER, resolved by the same rule cua-firstboot.ps1 uses (a real
# python, never the WindowsApps App Execution Alias, then the `py -3` launcher).
# It is duplicated ON PURPOSE: this file must be able to rebuild the launcher at
# boot without depending on the script that wrote it, and a guard that cannot
# rebuild is a guard that cannot repair R3.
function Get-RelayInterpreter {
  foreach ($candidate in @(Get-Command python -All -ErrorAction SilentlyContinue)) {
    if ($candidate.Source -and $candidate.Source -notmatch '\\WindowsApps\\' -and (Test-Path -LiteralPath $candidate.Source)) { return $candidate.Source }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py -and $py.Source) {
    try {
      $found = (& $py.Source -3 -c "import sys;print(sys.executable)" 2>$null | Select-Object -First 1)
      if ($LASTEXITCODE -eq 0 -and $found) {
        $found = ([string]$found).Trim()
        if ($found -and $found -notmatch '\\WindowsApps\\' -and (Test-Path -LiteralPath $found)) { return $found }
      }
    } catch { }
  }
  return $null
}

# THE LAUNCHER IS THE HARNESS-REPAIRABLE SOURCE OF TRUTH FOR THE PORT. The boot
# task's -Port is baked at provision time and nothing can update it later; the .vbs
# is rewritten by the harness's own repair (`--serve --port <port>`, win-mcp.js
# relayRepairScriptSource) and by New-RelayLauncher below, so the FILE names the
# port a relay actually listens on. Reading it back is what makes a diverged guest
# converge on the next boot instead of re-opening the split: probe the launcher's
# port, and the /run starts a relay on exactly that port.
#
# 0 MEANS "THE LAUNCHER DOES NOT SAY", never a guess. A missing file (rebuilt
# later), a launcher from a payload that predates the argument (bare --serve, where
# the relay's own default/env decides), and a value that is not a legal port all
# fall back to the caller's -Port. The regex scans the whole file because the port
# appears in both the informational comment line and the Run line, and both carry
# the same command; the FIRST `--port <digits>` is the one that runs.
function Get-LauncherPort([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if (-not $content) { return 0 }
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

# R3: A TASK WHOSE .vbs IS MISSING "STARTS" AND DOES NOTHING. So the launcher is
# rebuilt before the task is ever run, and the rebuild refuses to write a
# launcher that points at a relay script or an interpreter that is not there.
#
# IT ALWAYS WRITES THE PORT. A bare `--serve` makes the relay fall back to 47999
# (or to whatever a logon session happens to carry), while the caller probes the
# port IT resolved - the two agree only by luck. $Port is that resolved port, so
# the rebuilt launcher starts the relay exactly where this run is about to probe.
function New-RelayLauncher([int]$Port) {
  if (-not (Test-Path -LiteralPath $RelayScript)) { return $null }
  $py = Get-RelayInterpreter
  if (-not $py) { return $null }
  $command = "`"$py`" `"$RelayScript`" --serve --port $Port"
  # `--port <n>` STAYS IMMEDIATELY BEFORE THE CLOSING QUOTE: the harness repair
  # recognises a launcher it already fixed by looking for exactly that substring
  # (`'--port ' + $port + '"'`) and rewrites anything else, so a launcher built
  # here is only stable if it is built in the same shape.
  $runLine = 'shell.Run """' + $py + '"" ""' + $RelayScript + '"" --serve --port ' + [string]$Port + '", 0, False'
  # THE COMMAND LIVES IN A FILE because schtasks /tr is ONE command line Windows
  # re-parses: with the interpreter under "C:\Program Files" the nested quotes are
  # doubled beyond what any two parsers agree on. wscript.exe is GUI-subsystem, so
  # Run ..., 0, False starts the relay with no console window on the desktop this
  # task exists to automate.
  Set-Content -LiteralPath $Launcher -Encoding ASCII -Value @(
    "' cua-mcp-host: start the interactive-session MCP relay, hidden, no console.",
    "' REGENERATED by cua-relay-guard.ps1 (the launcher was missing); same command",
    "' cua-firstboot.ps1 writes. It lives here because schtasks /tr cannot carry",
    "' nested quotes:",
    # PARENTHESISED ON PURPOSE: inside @( ) the comma binds TIGHTER than +, so an
    # unparenthesised `"'   " + $x` silently becomes TWO array items - the comment
    # and the command on separate lines, which turns the command line into a VBS
    # statement and breaks the launcher.
    ("'   " + $command),
    'Set shell = CreateObject("WScript.Shell")',
    $runLine
  )
  return $Launcher
}

function Test-RelayTask([string]$Name) {
  try {
    & schtasks.exe /query /tn $Name 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

# THROUGH A .cmd FILE for the same quoting reason the launcher exists: Windows
# PowerShell 5.1 hands a variable containing spaces to a native program UNQUOTED,
# so `& schtasks /tr $var` arrives as `/tr wscript.exe //B ...` and schtasks takes
# only the first token as the action. cmd parses the quoted argument the
# documented way.
#
# THE FLAGS ARE THE CONTRACT, and they are the SAME ones cua-firstboot.ps1 uses,
# so a task repaired by the guard and a task created by firstboot are
# indistinguishable: /sc onlogon + /it (the interactive session, the only session
# whose desktop UIA can see), /ru <account> (WITHOUT it /it binds to the caller -
# SYSTEM - and schtasks refuses the create), /rl LIMITED (the user's own token,
# same integrity level as the windows the MCP server drives).
# ONE SHAPE, AND IT IS THE RELAY TASK'S: the guard task itself (/sc onstart, SYSTEM)
# belongs to cua-firstboot.ps1 (step relay-guard-task), which is the only place that
# knows the staged path it just wrote and the port it wrote into the action. A guard
# that re-registered ITSELF would be a second writer of its own trigger, and the two
# would disagree the first time either changed.
function New-RelayTask([string]$Name, [string]$CommandLine, [string]$Account) {
  $cmdFile = Join-Path $env:TEMP ('cua-relay-task-' + [string]$PID + '.cmd')
  $line = "schtasks /create /tn `"$Name`" /sc onlogon /ru `"$Account`" /it /rl LIMITED /f /tr `"$CommandLine`""
  @($line) | Set-Content -LiteralPath $cmdFile -Encoding ASCII
  # NO return INSIDE A try/finally: the exit code has to be read while it still
  # belongs to this call, and a missing cmd.exe (a stripped image, or a smoke run
  # on a non-Windows host) must read as failure, never as the last command's code.
  $code = 1
  try {
    & cmd.exe /c $cmdFile | Out-Null
    $code = $LASTEXITCODE
  } catch {
    $code = -1
  }
  Remove-Item -LiteralPath $cmdFile -Force -ErrorAction SilentlyContinue
  return $code
}

# THE REPAIR ITSELF: only what is missing, and the run only when it is still
# down (the caller reached here because the probe was negative). Returns what it
# did, so the one log line can say "task-created+run=0" instead of "attempted".
# -Port is threaded through so the launcher is rebuilt FOR THE PORT this run is
# probing: a repair that starts the relay somewhere else is the divergence again.
function Repair-Relay([string]$Account, [int]$Port) {
  if (-not (Test-Path -LiteralPath $RelayScript)) {
    return @{ action = 'relay-script-missing'; started = $false }
  }
  $steps = @()
  if (-not (Test-Path -LiteralPath $Launcher)) {
    $rebuilt = New-RelayLauncher -Port $Port
    if (-not $rebuilt) { return @{ action = 'launcher-unbuildable'; started = $false } }
    $steps += 'launcher-rebuilt'
  }
  if (-not (Test-RelayTask -Name $TaskName)) {
    if (-not $Account) {
      # PARENTHESISED: @( ) + string -join '+' reads correctly only because of
      # operator precedence, and this repository has already paid once for an
      # unparenthesised expression inside @( ).
      return @{ action = ((@($steps) + 'no-account') -join '+'); started = $false }
    }
    $created = New-RelayTask -Name $TaskName -CommandLine ('wscript.exe //B //NoLogo ' + $Launcher) -Account $Account
    if ($created -ne 0) {
      return @{ action = ((@($steps) + ('task-create-failed=' + [string]$created)) -join '+'); started = $false }
    }
    $steps += 'task-created'
  }
  # `schtasks /run` EXITS 0 WHEN THE REQUEST IS ACCEPTED, NOT WHEN THE RELAY IS
  # UP (J22-13) - the caller's next probe is the proof, and this line only says
  # whether Task Scheduler took the request.
  $run = 1
  try {
    & schtasks.exe /run /tn $TaskName 2>$null | Out-Null
    $run = $LASTEXITCODE
  } catch {
    $run = -1
  }
  $steps += ('run=' + [string]$run)
  return @{ action = (@($steps) -join '+'); started = ($run -eq 0) }
}

# ---------------------------------------------------------------------------
# AUTOLOGON - folded into the boot guard (SOL 4.5 / D2): one owner for "a session
# must exist", and the only place that can re-assert it on an ALREADY-provisioned
# guest, where a standalone firstboot step could never run again.
# ---------------------------------------------------------------------------

# Only AutoAdminLogon is re-written (when missing or 0), plus DefaultUserName when
# it is MISSING. DefaultPassword is read, never written: the guard cannot know the
# generated password, and overwriting it would break a working autologon. A
# different DefaultUserName is left alone (an operator's choice wins) and reported
# as user-mismatch; pw=absent in the log is the one fact a human must act on.
function Invoke-AutologonAssert([string]$Account) {
  $result = @{ value = 0; state = 'not-run'; user = $Account; password = 'unknown' }
  if (-not $Account) {
    $result.state = 'no-account'
    return $result
  }
  $current = $null
  try { $current = (Get-ItemProperty -LiteralPath $WinlogonKey -Name AutoAdminLogon -ErrorAction Stop).AutoAdminLogon } catch { $current = $null }
  if ([string]$current -ne '1') {
    try {
      # -ErrorAction Stop ON EVERY WRITE: a denied registry write ("Requested
      # registry access is not allowed") is a NON-TERMINATING error by default, so
      # without it the catch below never runs and a guard running on a token that
      # cannot write HKLM would report autologon=written - the lie this file exists
      # to prevent. The smoke test caught exactly that on a host with no HKLM:.
      if (-not (Test-Path -LiteralPath $WinlogonKey)) { New-Item -Path $WinlogonKey -Force -ErrorAction Stop | Out-Null }
      Set-ItemProperty -LiteralPath $WinlogonKey -Name AutoAdminLogon -Value '1' -Force -ErrorAction Stop
      $result.state = 'written'
    } catch {
      $result.state = 'write-failed'
    }
  } else {
    $result.state = 'present'
  }
  $currentUser = $null
  try { $currentUser = (Get-ItemProperty -LiteralPath $WinlogonKey -Name DefaultUserName -ErrorAction Stop).DefaultUserName } catch { $currentUser = $null }
  if (-not $currentUser) {
    try {
      Set-ItemProperty -LiteralPath $WinlogonKey -Name DefaultUserName -Value $Account -Force -ErrorAction Stop
      $result.user = $Account
    } catch { }
  } elseif ([string]$currentUser -ne $Account) {
    $result.user = [string]$currentUser
    $result.state = $result.state + '+user-mismatch'
  }
  $password = $null
  try { $password = (Get-ItemProperty -LiteralPath $WinlogonKey -Name DefaultPassword -ErrorAction Stop).DefaultPassword } catch { $password = $null }
  if ($password) { $result.password = 'present' } else { $result.password = 'absent' }
  if ($result.state -eq 'present' -or $result.state -eq 'written' -or $result.state -eq 'present+user-mismatch' -or $result.state -eq 'written+user-mismatch') { $result.value = 1 }
  return $result
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

$Mode = 'Boot'
if ($Ensure) { $Mode = 'Ensure' }
elseif ($Autologon) { $Mode = 'Autologon' }
elseif ($Boot) { $Mode = 'Boot' }   # the default, spelled out for the task's action line

# THE PORT, IN PRECEDENCE ORDER: launcher, then -Port, then the environment, then
# 47999. Resolve-Port already covers the last two; the launcher is read AFTER it so
# a launcher port always wins, but only for the modes that actually probe (an
# -Autologon run has no port question at all).
#
# THIS ORDER IS THE FIX. The task action's -Port is frozen at provision time, while
# the harness may probe and repair the launcher to a different port at any attach;
# probing the frozen number made every boot on a diverged guest wait 90 s and then
# /run a task whose relay was already answering - 10048, and ok=0 for a lane that
# was up. The launcher is what the /run would start, so the launcher is what to
# probe.
$Port = Resolve-Port -Value $Port
# WHERE THAT NUMBER CAME FROM, for the one log line: an operator reading a record
# that says port=48000 needs to know whether the task baked it or a repaired
# launcher did, because the second one is the harness agreeing with the guest.
$PortSource = 'param'
if (-not $PSBoundParameters.ContainsKey('Port')) { $PortSource = 'env' }
if ($Mode -ne 'Autologon') {
  $launcherPort = Get-LauncherPort -Path $Launcher
  if ($launcherPort -gt 0) {
    $Port = $launcherPort
    $PortSource = 'launcher'
  }
}
if ($WaitSeconds -le 0) {
  if ($Mode -eq 'Boot') { $WaitSeconds = 90 } else { $WaitSeconds = 10 }
}

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$Account = Resolve-RelayAccount -Explicit $User
$Session = Get-ConsoleSession -Account $Account
$AutologonResult = @{ value = -1; state = 'not-run'; user = $Account; password = 'unknown' }
$Action = 'none'
$Reason = ''
$Answer = ''
$Ok = $false

if ($Mode -eq 'Autologon') {
  $AutologonResult = Invoke-AutologonAssert -Account $Account
  $Ok = ($AutologonResult.value -eq 1)
  if (-not $Ok) { $Reason = 'autologon-not-asserted' }
} else {
  if ($Mode -eq 'Boot') {
    $AutologonResult = Invoke-AutologonAssert -Account $Account
  }

  # HANDSHAKE FIRST. A relay that is already answering needs nothing from this
  # script - not an autologon write, not a session wait, and definitely not a
  # /run that would race it for the bind. Test-RelayPing is the boolean form of
  # the one probe; asking it here (rather than reading the token) is what makes
  # "already up" cost one connection and no delay.
  if (Test-RelayPing -Port $Port -TimeoutMs $ProbeTimeoutMs) {
    $Answer = 'RELAY_OK'
    $Action = 'already-up'
  } else {
    $Answer = ''
    if ($Mode -eq 'Boot') {
      # THE SESSION WAIT: an InteractiveToken task cannot start before a logon,
      # so waiting for the console session is waiting for the thing that starts
      # the relay. It is bounded AND it stops the moment the probe answers (the
      # onlogon task may already have won the race).
      $deadline = (Get-Date).AddSeconds($WaitSeconds)
      while ((Get-Date) -lt $deadline) {
        if (-not $Session.id) { $Session = Get-ConsoleSession -Account $Account }
        $Answer = Get-RelayAnswer -Port $Port -TimeoutMs $ProbeTimeoutMs
        if ($Answer -ceq 'RELAY_OK') { $Action = 'up-at-logon'; break }
        Start-Sleep -Milliseconds 1000
      }
    }
    if ($Answer -cne 'RELAY_OK') {
      if (-not $Session.id) { $Session = Get-ConsoleSession -Account $Account }
      $repair = Repair-Relay -Account $Account -Port $Port
      $Action = $repair.action
      # The start window: a cold pythonw.exe plus the dsh_cua import is what the
      # 20 x 500 ms in firstboot covered, so -Ensure keeps exactly that budget and
      # -Boot allows the same for the onstart path (A3: answer within 20 s).
      #
      # ONLY WHEN SOMETHING WAS ACTUALLY STARTED. A repair that could not run
      # (no relay script, no interpreter, no account) has nothing to wait for, and
      # burning the full window on it would make a SYSTEM pass that cannot start a
      # relay look like a slow success instead of an immediate, recorded failure.
      $startWait = 20
      if ($Mode -ne 'Boot') { $startWait = $WaitSeconds }
      if ($repair.started) {
        $Answer = Wait-Relay -Port $Port -Seconds $startWait -TimeoutMs $ProbeTimeoutMs
      } else {
        $Answer = Get-RelayAnswer -Port $Port -TimeoutMs $ProbeTimeoutMs
      }
    }
  }

  $Ok = ($Answer -ceq 'RELAY_OK')
  if (-not $Ok) {
    if (-not (Test-Path -LiteralPath $RelayScript)) { $Reason = 'relay-missing' }
    elseif ($Answer) { $Reason = 'probe-skew' }
    elseif (-not $Session.id) { $Reason = 'no-interactive-session' }
    else { $Reason = 'relay-stopped' }
  }
}

# ONE LINE. The keys are the harness record's keys (App. B) so a human can read the
# guest log and the harness log side by side and see the same vocabulary.
$taskRegistered = 0
if (Test-RelayTask -Name $TaskName) { $taskRegistered = 1 }
$probeToken = 'RELAY_DOWN'
if ($Answer) { $probeToken = $Answer }
$record = @(
  ('mode=' + $Mode),
  ('ok=' + [string][int]$Ok),
  ('port=' + [string]$Port),
  # WHICH PORT THIS RUN ACTUALLY PROBED, and where it came from: `launcher` means
  # the harness and the guest agree, `param` means the boot task's baked value was
  # the only source (no launcher port yet). Without this key, a record cannot
  # distinguish "the probe used the harness's port" from "the probe used the port
  # firstboot froze at provisioning" - the exact question the divergence raises.
  ('portsrc=' + $PortSource),
  ('task=' + [string]$taskRegistered),
  ('session=' + [string]$Session.id),
  ('probe=' + $probeToken),
  ('reason=' + $Reason),
  ('action=' + $Action),
  ('autologon=' + $AutologonResult.state),
  ('user=' + ([string]$Account)),
  ('pw=' + $AutologonResult.password),
  ('ms=' + [string][int]$clock.ElapsedMilliseconds)
)
$line = (Get-Date).ToString('o', $Invariant) + ' ' + ($record -join ' ')
try {
  New-Item -ItemType Directory -Force -Path $Dir -ErrorAction SilentlyContinue | Out-Null
  Add-Content -LiteralPath $LogPath -Value $line -Encoding ASCII
} catch { }
Write-Output $line

if ($Ok) { exit 0 }
exit 1
