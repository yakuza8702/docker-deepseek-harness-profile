<#
  cua-clip-agent.ps1 - the IN-SESSION clipboard loop for a Windows computer.

  WHY A LOOP AND NOT A TASK PER PASTE
    A clipboard is state, not an event: a human copies in Notepad and expects
    the harness (and the noVNC view) to see it WITHOUT asking. The old design ran
    `cua-clip-get` on demand, so the guest's clipboard was only visible when the
    supervisor asked - and every read was a fresh task launch (~1 s). This file
    runs ONCE, at logon, IN THE USER'S OWN SESSION (`/it` - the only session where
    Set-Clipboard/Get-Clipboard mean anything; sshd lives in Session 0 with its
    own empty clipboard), and moves both directions forever:

      guest -> host   poll the visible clipboard, and on a change write
                      clip-current.txt + clip-state.json (seq, sha256, chars, at)
      host -> guest   watch outbox\clip-*.json, apply it, then ack in
                      clip-ack.json and delete the request

  WHO READS/WRITES WHAT
    The supervisor writes the outbox requests and reads clip-state.json /
    clip-ack.json over SSH; the harness's noVNC bridge reads through the
    supervisor. This process is the only writer of clip-current.txt,
    clip-state.json and clip-ack.json, and it writes NOWHERE else: everything is
    under C:\ProgramData\cua.

  TWO LOGON SESSIONS MUST NOT SHARE ONE OUTBOX (J22-11)
    A console logon and an RDP logon each own a DIFFERENT clipboard. With one set
    of files, a paste meant for session 2 was applied by whichever loop polled
    first - i.e. into a clipboard nobody was looking at - and the two loops
    overwrote each other's state and ack. So every per-session file carries the
    session id: clip-state-<id>.json, clip-ack-<id>.json, clip-current-<id>.txt,
    outbox-<id>\. Exactly ONE session owns the loop: if another live session's
    state file is fresher than $OwnerWindowSeconds, this loop stays idle (touching
    no file, applying no request) and re-checks every 60 s, so it takes over if
    the owner dies. The owner keeps its state file fresh with a heartbeat touch, so
    a quiet clipboard does not hand ownership back and forth.

    THE BACKEND DOES NOT KNOW ABOUT THE SUFFIX: it still reads clip-state.json /
    clip-ack.json / clip-current.txt and still writes outbox\. The owner therefore
    writes BOTH - the suffixed file (its own record, and the lock's evidence) and
    the un-suffixed canonical copy - and READS the un-suffixed paths as the legacy
    fallback when it starts (seq baseline, and the shared outbox).

  THE ORDER OF A PASTE (J22-4)
    SET clipboard, READ IT BACK, WRITE clip-current.txt, ACK, DELETE the request.
    The read-back is written BEFORE the ack on purpose: a reader that sees an ack
    with a matching seq can then trust that clip-current.txt already holds what
    the paste produced. The old order acked first and left clip-current.txt for
    the next poll cycle, so a readBackEqual check raced the very file it was
    supposed to describe.

  THE SEQ FIELD IS [long] EVERYWHERE (J22-3)
    The supervisor stamps seq with Date.now(), i.e. about 1.79e12 today. Int32
    tops out at 2147483647, and casting the request's seq field to it is an
    exception, not a wrong number: the parse threw, the ack carried seq 0 and the
    request was silently dropped. Every seq in this file - parsed, compared,
    stored, acked - is [long].

  THE SIZE TEST IS ON THE TEXT, IN CHARS (J22-5)
    A JSON request is not its payload: quotes, backslashes and control characters
    are escaped, so a 900 K-char paste easily makes a 1.2 MB file. Testing the FILE
    length first refused legitimate pastes that the backend had already accepted,
    and that refusal acked sha256:'' - which the backend cannot tell apart from
    "nothing happened". The test is now $MaxChars on the TEXT, and the ack always
    carries the sha256 of the requested text plus an `error` naming the refusal.

  PRIVACY OFF-SWITCH (J20-1b) - CONTRACT WITH windows-oem/cua-firstboot.ps1
    DSH_CUA_CLIP_AGENT=0 means "do not run the ambient clipboard loop". A guest
    cannot read the host environment at runtime, so the switch is materialized as
    a FILE by the backend at VM creation / staging time:

        C:\ProgramData\cua\clip-agent-disabled        (sentinel; exists = disabled)

    The backend-side writer is another lane's job; this file only CONSUMES the
    sentinel. cua-firstboot.ps1 checks the same path BEFORE registering the
    cua-clip-agent task and records the skip in C:\cua-provision.json; this script
    checks it at startup too and exits quietly if it was started anyway (a machine
    whose task was registered before the switch was flipped).

  WHY ASCII ONLY
    The file is authored ASCII (no smart quotes, no dashes above U+007E). Windows
    PowerShell 5.1 reads a BOM-less .ps1 as ANSI, i.e. codepage 1252/936 on a
    localized install, and a single U+2014 in a comment becomes a parse error in
    a language nobody debugged. Everything non-ASCII is built at runtime from
    .NET, never typed into this file.

  CLIPBRD_E_CANT_OPEN IS NORMAL
    Any process may hold the clipboard for a few milliseconds; the COM error
    0x800401D0 ("OpenClipboard failed") is expected traffic, not a failure. Three
    attempts with a growing delay, then "unknown this cycle" - which must NOT be
    written as an empty clipboard, because that would look like a change and
    push a blank string to the other side.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms

$Dir = 'C:\ProgramData\cua'

# THE PRIVACY OFF-SWITCH, CONSUMED EARLY (J20-1b). See the contract in the header:
# the sentinel is written by the BACKEND when DSH_CUA_CLIP_AGENT=0, and this loop
# must not run at all when it is there.
if (Test-Path -LiteralPath (Join-Path $Dir 'clip-agent-disabled')) { exit 0 }

# THE SESSION ID IS READ FIRST BECAUSE IT IS PART OF EVERY PATH (J22-11). sshd
# would report session 0; this loop only ever runs in an interactive session, so
# the value is the console/RDP session number.
$sessionId = 0
try { $sessionId = [int](Get-Process -Id $PID).SessionId } catch { $sessionId = 0 }
$SessionTag = '-' + [string]$sessionId

# Canonical (un-suffixed) paths: what the backend reads and writes. Scoped paths:
# this session's own record and the single-owner lock's evidence.
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
# UTF-8 with NO BOM: the supervisor reads these files as UTF-8, and a BOM would
# travel into the clipboard text as U+FEFF.
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
  # ConvertTo-Json with a fixed depth; the files are flat, the depth is a guard
  # against a future field silently becoming [System.Object] in the output.
  #
  # THE OWNER WRITES BOTH PATHS (J22-11): the suffix is this session's own record,
  # the un-suffixed file is what the backend already reads. Same bytes, so a
  # reader on either path sees one truth.
  $json = $Object | ConvertTo-Json -Depth 4 -Compress
  [System.IO.File]::WriteAllText($Scoped, $json, $Utf8NoBom)
  [System.IO.File]::WriteAllText($Canonical, $json, $Utf8NoBom)
}

function Write-TextPair([string]$Canonical, [string]$Scoped, [string]$Text) {
  [System.IO.File]::WriteAllText($Scoped, $Text, $Utf8NoBom)
  [System.IO.File]::WriteAllText($Canonical, $Text, $Utf8NoBom)
}

function Test-SessionAlive([int]$Session) {
  # A STATE FILE THAT STOPPED MOVING IS NOT PROOF OF LIFE: a crashed loop leaves
  # its file behind. Only a session with at least one live process may hold the
  # lock. When the process list cannot be read at all, answer "alive": staying
  # idle is the safe side, the alternative is two loops pasting into two
  # different clipboards.
  try {
    return (@(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.SessionId -eq $Session } |
      Select-Object -First 1).Count -gt 0)
  } catch { return $true }
}

function Test-OtherOwner {
  # TRUE when ANOTHER live session published state within $OwnerWindowSeconds.
  $cutoff = [DateTime]::UtcNow.AddSeconds(-$OwnerWindowSeconds)
  foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Filter 'clip-state-*.json' -File -ErrorAction SilentlyContinue)) {
    $idText = $item.BaseName.Substring('clip-state'.Length).TrimStart('-')
    $id = -1
    if (-not [int]::TryParse($idText, [ref]$id)) { continue }
    if ($id -eq $sessionId) { continue }
    if ($item.LastWriteTimeUtc -gt $cutoff -and (Test-SessionAlive $id)) { return $true }
  }
  # THE LEGACY FILE IS ALSO EVIDENCE: before the suffix existed the single
  # clip-state.json was the only record, and it names its owner in `session`.
  if (Test-Path -LiteralPath $StatePath) {
    try {
      $legacy = Get-Item -LiteralPath $StatePath
      if ($legacy.LastWriteTimeUtc -gt $cutoff) {
        # NO `session` FIELD MEANS "UNKNOWN OWNER", NOT SESSION 0: a file written
        # by a version older than the field must not lock both sessions out of
        # the loop (session 0 always has live processes, so it would never age
        # out of the check).
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
  # TOUCH, DO NOT REWRITE: the mtime is the lock's liveness signal, while the
  # CONTENT must not change - a rewritten state file would look like a new paste
  # to the backend on every heartbeat.
  $now = [DateTime]::UtcNow
  foreach ($path in @($StatePathSession, $StatePath)) {
    try {
      if (Test-Path -LiteralPath $path) { [System.IO.File]::SetLastWriteTimeUtc($path, $now) }
    } catch { }
  }
}

<#
  THE VISIBLE CLIPBOARD, OR $null WHEN IT IS UNREADABLE.
  $null is deliberately distinct from '': a locked clipboard is not an empty
  one, and treating it as empty would emit a spurious "change" every 400 ms.
#>
function Read-ClipboardText {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      # NOT `[string]...`: a genuine $null must stay $null (see the comment on
      # this function), so the empty-string case is decided here, explicitly.
      $value = [System.Windows.Forms.Clipboard]::GetText()
      if ($null -eq $value) { return '' }
      return [string]$value
    } catch {
      # 3x backoff: 40, 80, 120 ms. Anything longer than that is a real hang and
      # the next cycle retries anyway.
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
  # TEXT FIRST, THEN THE STATE THAT VOUCHES FOR IT (J22-4): clip-state.json must
  # never name a clip-current.txt that has not been written yet.
  Write-TextPair $CurrentPath $CurrentPathSession $Text
  Write-JsonPair $StatePath $StatePathSession $state
}

<#
  ONE OUTBOX REQUEST: apply it, acknowledge it, then delete it.

  Order matters and is the contract: SET first, READ BACK second, WRITE
  clip-current.txt third, ACK fourth, DELETE last. The read-back lands in
  clip-current.txt BEFORE the ack (J22-4), so an ack whose seq matches the request
  is proof that clip-current.txt already holds the pasted text. A crash between
  the ack and the delete repeats the paste on the next cycle (harmless,
  idempotent); a crash before the ack leaves the request and the ack stale, which
  the next cycle overwrites. Deleting first would lose the request with no
  evidence.
#>
function Invoke-OutboxItem($File, [int]$Session) {
  # [long] FROM THE FIRST ASSIGNMENT (J22-3): the supervisor's seq is a
  # Date.now() stamp (~1.79e12) and Int32 cannot hold it.
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
    # THE SHA IS COMPUTED BEFORE ANY REFUSAL (J22-5): a too-large ack must still
    # name the text it refused, otherwise the backend cannot tell it apart from an
    # empty reply.
    $expected = Get-Sha256 $text
    if ($text.Length -gt $MaxChars) {
      # THE SIZE TEST IS ON THE TEXT, IN CHARS, NOT ON THE JSON FILE (J22-5):
      # escaping inflates the file, so a legal paste could exceed the old file
      # limit and be refused here while the backend thought it was fine.
      $error = 'too-large'
    } else {
      Set-Clipboard -Value $text
      $pasted = $true
      # A short settle: Set-Clipboard returns before the owner has rendered the
      # data, and Get-Clipboard immediately after can read the PREVIOUS value.
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
    # BEFORE THE ACK (J22-4). A failed write here is not fatal - the ack below
    # still answers the writer - but it must not leave the ack pointing at stale
    # text, so the ack's `equal` flag is what the reader should trust.
    try { Write-TextPair $CurrentPath $CurrentPathSession $readBack } catch { }
  }
  if ($wantAck) {
    # Never an ok:false with no reason (J22-5): a refusal the backend cannot name
    # is indistinguishable from a request that was never processed.
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
  # BOTH DIRECTORIES: this session's own outbox first, then the shared legacy one
  # the backend still writes to (J22-11 keeps the backend unchanged). The owner is
  # the only loop that gets here, so a request cannot be applied twice.
  $pending = @()
  foreach ($dir in @($OutboxSession, $Outbox)) {
    $pending += @(Get-ChildItem -LiteralPath $dir -Filter 'clip-*.json' -File -ErrorAction SilentlyContinue)
  }
  $pending = @($pending | Sort-Object LastWriteTime | Select-Object -First $MaxOutboxPerCycle)
  foreach ($file in $pending) {
    Invoke-OutboxItem $file $Session
  }
}

# THE SEQ BASELINE COMES FROM DISK WHEN IT CAN - this is the legacy fallback read
# (J22-11): a restarted loop must not re-announce a clipboard the backend already
# saw, and a machine that was running the un-suffixed version must not start over
# at seq 1.
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
  # OWNERSHIP (J22-11). Only the session with the freshest state works; the other
  # one stays idle and asks again in a minute.
  if (Test-OtherOwner) {
    # Touching NO file and applying NO request is the point: a paste here would
    # land in a clipboard nobody is looking at, and a heartbeat would steal the
    # lock back and forth between the two sessions.
    Start-Sleep -Seconds 60
    continue
  }

  try { Invoke-Outbox $sessionId } catch { }

  $text = Read-ClipboardText
  if ($null -ne $text) {
    $sha = Get-Sha256 $text
    # The first pass publishes even when the text is unchanged: it is the proof
    # of life cua-firstboot.ps1 waits for after `schtasks /run` (J22-13), and it
    # costs one identical state file.
    if (($sha -ne $lastSha) -or (-not $published)) {
      $advanced = $false
      if ($sha -ne $lastSha) { $seq += 1; $advanced = $true }
      try {
        Write-ClipboardState $text $seq $sessionId
        $lastSha = $sha
        $published = $true
        $lastBeat = [DateTime]::UtcNow
      } catch {
        # A failed write must not advance the baseline: the next cycle retries
        # the same change instead of reporting it as already delivered.
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
