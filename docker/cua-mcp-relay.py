#!/usr/bin/env python3
# -*- coding: ascii -*-
"""cua-mcp-relay.py - keep the dsh-cua MCP server in the INTERACTIVE Windows
session while the SSH stdio transport stays exactly as it is.

THE DEFECT THIS EXISTS FOR (observed, not guessed)
--------------------------------------------------
`ssh cua@HOST "python -m dsh_cua.server --stdio"` gives the harness a working
JSON-RPC channel - and a server that cannot see the desktop. sshd runs as a
service, so the command inherits the SSH service's session (Session 0). UIA is
per-session: from Session 0 `list_windows` returns ZERO windows, and a notepad
started by a tool is created "in Services" (invisible to the logged-on user).
No amount of retrying fixes that; the server has to live where the desktop is.

WHY A RELAY AND NOT A NEW TRANSPORT
-----------------------------------
The MCP client (plugins/dsh-cua-vm/win-mcp.js) speaks JSON-RPC over the SSH
channel's stdio and must keep doing so: an SSH exec channel is a byte pipe, it
works through every firewall, and it needs nothing installed on the host. So the
SSH side keeps its stdio server contract and this file supplies the missing
half:

    harness --(ssh stdio)--> [relay --connect] --(127.0.0.1)--> [relay --serve]
                                                                      |
                                                              python -m dsh_cua.server --stdio
                                                              (started by a /it task, i.e. IN
                                                               the logged-on user's session)

`--connect` is the process the SSH command starts: it touches no desktop, it is
a plain byte bridge from fd 0/1 to a loopback socket. `--serve` runs from the
`cua-mcp-host` scheduled task (schtasks /sc onlogon /it), so its child MCP
server is a child of the interactive session and pywinauto sees the real
desktop.

BINARY SAFETY / NO LINE TRANSLATION
-----------------------------------
MCP JSON is length-prefixed only by its framing; a pty would rewrite CR/LF and
mangle it. Every hop here is raw bytes: os.read/os.write on pipes (buflen-driven,
never line-buffered), socket.recv/sendall on the wire, no text mode anywhere, no
encoding decision. The only text this file writes is its own one-line log.

HEALTH PROBE THAT DOES NOT DISTURB A SESSION
--------------------------------------------
A probe connection whose FIRST BYTES are exactly b'RELAY_PING' is answered with
b'RELAY_OK' and closed, before any child is spawned or touched. A second verb,
RELAY_FN, is answered with ONE line of JSON evidence - the live counters below -
and closed the same way. A real MCP client sends `{"jsonrpc":...` first,
so the three cases are unambiguous: its first byte matches neither token. Both
verbs are handled OUTSIDE the single-session lock, so a health check cannot be
blocked by (or block) a live MCP session.

WHAT RELAY_OK MEANS, AND WHAT IT DOES NOT
-----------------------------------------
RELAY_OK means the relay's accept loop answered the RELAY_PING handshake inside
2 s. It is **not** a claim about the MCP child: the child is proven only by the
functional probe (RELAY_FN, then a real initialize + tools/list round trip),
whose answer is RELAY_OK with measured:true or RELAY_UNRESPONSIVE. So the cheap
probe may decide the LANE - an accept loop that answers beats Session 0, and a
dead child is restarted on demand - but it never decides a VERDICT.

A WEDGED CHILD IS KILLED, AND ITS CALLERS ARE ANSWERED
------------------------------------------------------
Every request id this process forwards is recorded AFTER the bytes are already
on their way, and an inbound response pops it. A watchdog ticks every 250 ms;
when the OLDEST unanswered id is older than WEDGE_DEADLINE_MS (20 s by default)
it kills the child (proc.kill(), i.e. TerminateProcess - a wedged child is not
asked to close stdin) and then answers EVERY outstanding id, ascending, with a
JSON-RPC error whose message starts "child-wedged:". The client socket is never
closed: the next request spawns a fresh child and the lane heals in place. The
call that tripped the deadline did not return, so its effect is UNKNOWN, and
the message says so - re-observe before retrying. Accounting is PASSIVE: the
pumps hand a COPY of the bytes they already wrote to a line buffer capped at
1 MiB, and past the cap that LINE is dropped and its tail resynced - never a
forwarded byte. A result bigger than the cap is normal (a screenshot, a text
dump), so the ids outstanding when it was dropped stop being trusted instead of
ageing into a wedge: our own memory budget must never kill a healthy child.
DSH_CUA_MCP_WEDGE_DEADLINE_MS=0 disables the watchdog entirely. No COM, UIA or pywin32 module is imported for any of
this and the desktop is never touched: it is a plain out-of-process timer,
which is why it may default ON where an in-process UIA event pump may not.

DESKTOP FACTS: THE ONE THING MEASURED, NOT BRIDGED
---------------------------------------------------
Every claim this repo makes about the desktop used to be an assumption formed on
the host. The listener mode is the only process that holds the desktop token, so
it is the only one that can answer: does `win32ui` import, does the pywinauto UIA
wrapper import, does the installed `dsh_cua.bridge` carry the corrected scale
arithmetic, and can THIS token write `C:\\cua-work` - and its own profile root
(the measured contrast, never a "fix")? It answers in a daemon thread started
AFTER the listener binds (never in front of accept), bounded at 20 s per pass,
and writes one JSON object to `C:\\cua-work\\cua-desktop-facts.json`, falling
back to `%TEMP%` when the work directory is not writable. A failure writes the
same file with `measured:false` and the reason. No pump, no file descriptor and
no argument changes: `--ping` still answers while it runs, and no byte of the
MCP stream is touched.

IT RE-MEASURES. A measurement taken once per --serve process is a snapshot that
can only rot: a guest whose ACL healed after start reported a false permanent
`workDirWritable:false`, and a guest whose lane died after start reported a
false permanent `elementLaneOk:true`. So the pass repeats - every
FACTS_REFRESH_MS while any lane/work-dir fact is not true, every
FACTS_FULL_REFRESH_MS once they all are - and after FACTS_SUSPECT_MAX identical
suspect passes it backs off to the full interval, so a permanently broken guest
is not probed 1440 times a day. Each pass rewrites the same file through a temp
file plus os.replace, so a reader never sees a torn object, and the file carries
`refreshMs` (the effective interval) plus the live `relay` counters so the host
can tell an honest 15-minute refresh from a dead file.

MODES
-----
  python cua-mcp-relay.py --serve     listen 127.0.0.1:<port>, one client at a
                                      time, child kept/restarted as needed
  python cua-mcp-relay.py --connect   bridge stdin/stdout <-> 127.0.0.1:<port>
  python cua-mcp-relay.py --ping [port]
                                      Liveness of the accept loop: send
                                      RELAY_PING, read the 8-byte answer, print
                                      exactly RELAY_OK or RELAY_DOWN. Bounded to
                                      ~2 s wall, no child, no lock, no desktop
                                      access. RELAY_OK here says the loop
                                      answered; it does NOT claim the MCP child
                                      (see the section above).

  A probe connection may also send the RELAY_FN token instead: the listener
  answers ONE JSON line carrying its live counters (lastSuccessfulCallAgeMs,
  outstandingRequestAgeMs, childRestarts, lastWedgeAt, childPid,
  wedgeDeadlineMs, busy, attached, mode, at) and closes. That is the evidence
  the host-side functional probe reads before it opens a real session; it is
  answered before the session lock, exactly like the cheap probe.

ENVIRONMENT
-----------
  DSH_CUA_MCP_RELAY_PORT   listen/connect port, default 47999
  DSH_CUA_MCP_SERVER       child command line override
                           (default: "python -m dsh_cua.server --stdio")
  DSH_CUA_MCP_RELAY_LOG    log path override (default on Windows:
                           C:\\ProgramData\\cua\\mcp-relay.log)
  DSH_CUA_MCP_WEDGE_DEADLINE_MS
                           ms an unanswered request may age before the child is
                           killed and the call answered "child-wedged" (default
                           20000; 0 disables the watchdog; clamped
                           200..600000)
  DSH_CUA_MCP_FACTS_REFRESH_MS
                           facts refresh interval while the guest looks SUSPECT
                           (default 60000; 0 measures once and stops)
  DSH_CUA_MCP_FACTS_FULL_REFRESH_MS
                           facts refresh interval while the guest looks HEALTHY
                           (default 900000)

EXIT CODES
----------
  --connect  0 on a clean close (either side), 1 when the port refuses
  --serve    0 on Ctrl-C, 1 when the listener cannot bind
  --ping     0 when the relay answered RELAY_OK, 1 on any failure
             (refused / timeout / short read / EOF / bad answer)

WHY --ping EXISTS (measured, not guessed)
-----------------------------------------
The Windows health check used to be a PowerShell one-liner over SSH. On a cold
tiny10 guest that process takes ~4.6 s to start and warm up, which blew its 8 s
budget right after boot and reported RELAY_DOWN while the relay was fine - so
the harness fell back to the Session 0 path. This mode is the replacement: one
socket, two writes, no child process, no interpreter spawn of anything but the
guest's own `py -3`, so it answers in milliseconds warm and is still bounded
when the port is dead.

Stdlib only, ASCII only, and the pump is written so the whole file can be
exercised on Linux (`DSH_CUA_MCP_SERVER=cat` is a byte-exact echo server).
"""

import errno
import json
import os
import queue
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

# The probe TOKENS. Fixed bytes, compared with ==, never stripped or decoded.
# `RELAY_FN` is deliberately NOT a `RELAY_PING` prefix: a token spelled
# `RELAY_PING_FN` would be answered by the 10-byte cheap path the moment its
# `RELAY_PING` prefix had arrived, before its own trailing bytes were ever seen.
PROBE_PING = b'RELAY_PING'
PROBE_FN = b'RELAY_FN'
PROBE_OK = b'RELAY_OK'
PROBE_DOWN = b'RELAY_DOWN'
# The token SET, in one place: a probe is answered when the buffer EQUALS one of
# these, and reading continues while SOME token still starts with the buffer.
PROBES = ((PROBE_PING, 'ping'), (PROBE_FN, 'functional'))
# One request outstanding longer than this is a WEDGED child: not slow, never
# coming back (a PostMessage/WM_GETTEXT/UIA call that will not return). 20 s sits
# under the host's 25 s per-call transport budget on purpose - the guest clock
# starts later than the host's, so the answer must be able to arrive first.
WEDGE_DEADLINE_MS = 20000
WEDGE_DEFAULT_MS = WEDGE_DEADLINE_MS
# How often the watchdog looks. Cheap: one min() over a dict that is empty
# whenever nothing is outstanding.
WEDGE_TICK_MS = 250
WEDGE_ERROR_CODE = -32000
# How long the watchdog may wait for the client's write lock before it gives
# up on that answer. A stalled client must not freeze the watchdog (it has
# other wedges to police), and an answer it will never read is not worth
# blocking a thread for.
WEDGE_ANSWER_TIMEOUT = 2.0
# The pairing line buffer never grows past this. Past the cap it is DROPPED:
# pairing degrades to "not measured", forwarding is untouched.
SCAN_CAP = 1048576
# How long a fresh connection may take to prove itself a probe or a session.
# An MCP client sends `initialize` immediately, so this only bounds the cost of
# a connection that says nothing at all.
PROBE_WINDOW = 2.0
# --ping is the replacement for the ~4.6 s cold PowerShell health check, so its
# budgets are hard: one socket, and the whole run is over well inside the
# caller's 8 s. PING_TIMEOUT bounds each socket operation; PING_BUDGET bounds
# the run (connect + send + read-all) even if an operation were to overrun.
PING_TIMEOUT = 1.5
PING_BUDGET = 2.0
DEFAULT_PORT = 47999
LOOPBACK = '127.0.0.1'
DEFAULT_SERVER = 'python -m dsh_cua.server --stdio'
CHUNK = 65536
# Windows: never give the child a console. The relay itself is started by an
# interactive task (pythonw.exe, no console); a plain python.exe child would
# allocate one and leave the blank window on the user's desktop that the
# windowless-autostart fix exists to prevent.
CREATE_NO_WINDOW = 0x08000000

# --------------------------------------------------------------------------- #
# the desktop-facts contract (paths, the two probes, the one bound)
# --------------------------------------------------------------------------- #
# WHY IN THIS PROCESS: the guest tools run in the logged-on user's session and
# this relay is the only process on the guest that shares that token. The host
# can ask the question but cannot answer it, so the answer is measured here
# once and left in a file the client reads (contract Appendix B).
DESKTOP_FACTS_SCHEMA = 1
DESKTOP_FACTS_NAME = 'cua-desktop-facts.json'
# The directory cua-firstboot.ps1 creates with an explicit DACL and a Medium
# integrity label. The relay never creates it: a directory THIS process made
# would prove nothing about the token the tools run as.
WORK_DIR = 'C:\\cua-work'
WRITE_PROBE_NAME = '.cua-write-probe'
# Every child spawned for a measurement is bounded, and the whole pass is one
# shot. The listener never waits for any of it.
FACTS_PROBE_TIMEOUT = 20
# HOW OFTEN the pass repeats. A measurement taken once per --serve process can
# only rot: the ACL heals (or the lane dies) and the file keeps reporting boot
# time forever. SUSPECT means any of measured/win32ui/uiaLane/workDirWritable is
# not true, and refreshes fast because that is the guest that needs to heal;
# a fully healthy guest is re-measured slowly because re-proving it costs four
# subprocesses. FACTS_SUSPECT_MAX identical suspect passes back off to the full
# interval so a permanently broken guest is not probed 1440 times a day.
FACTS_REFRESH_MS = 60000
FACTS_FULL_REFRESH_MS = 900000
FACTS_SUSPECT_MAX = 5
# ONE subprocess for both versions, so the cheapest facts (what is installed)
# are also the least intrusive: importlib.metadata reads no modules.
VERSION_PROBE = (
    'import json, importlib.metadata as md\n'
    'def one(name):\n'
    '    try:\n'
    '        return md.version(name)\n'
    '    except Exception:\n'
    "        return ''\n"
    'print(json.dumps({"dsh-cua": one("dsh-cua"), '
    '"pywin32": one("pywin32")}))'
)
# WHERE the module lives, without executing it: bridge.py imports windll at
# module level, so a diagnostic must never `import dsh_cua.bridge` (and even
# find_spec would import the package's __init__). The distribution's own file
# table answers the same question with no module code running at all.
SCALE_PROBE = (
    'import importlib.metadata as md\n'
    'try:\n'
    "    dist = md.distribution('dsh-cua')\n"
    "    print(dist.locate_file('dsh_cua/bridge.py'))\n"
    'except Exception:\n'
    "    print('')\n"
)


_log_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# logging: one line per event, appended, never fatal
# --------------------------------------------------------------------------- #
def log_path():
    """Where the one-line event log lives (env override for tests)."""
    override = os.environ.get('DSH_CUA_MCP_RELAY_LOG', '')
    if override.strip():
        return override.strip()
    if os.name == 'nt':
        return os.path.join('C:\\ProgramData', 'cua', 'mcp-relay.log')
    # A Linux host only runs this to test the pump; keep it out of the way.
    return os.path.join(tempfile.gettempdir(), 'cua-mcp-relay.log')


def event(kind, detail=''):
    """Append one timestamped line. Logging must never break the pump."""
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S')
    line = '%s pid=%d %s' % (stamp, os.getpid(), kind)
    if detail:
        line += ' ' + str(detail).replace('\r', ' ').replace('\n', ' ')
    try:
        with _log_lock:
            path = log_path()
            parent = os.path.dirname(path)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent)
            handle = open(path, 'ab')
            try:
                handle.write((line + '\n').encode('ascii', 'replace'))
            finally:
                handle.close()
    except Exception:
        pass


def note(text):
    """Diagnostics to stderr when there is one (pythonw.exe has none)."""
    try:
        if sys.stderr is not None:
            sys.stderr.write('cua-mcp-relay: %s\n' % (text,))
            sys.stderr.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# the two env-tuned numbers: the wedge deadline and the facts interval
# --------------------------------------------------------------------------- #
# BOTH are read AT CALL TIME, not at import: a test (and a support engineer
# restarting a task with one env var changed) gets the value that is in force
# now, and a value that cannot be parsed falls back to the shipped default with
# one log line instead of a traceback in a pythonw.exe process with no console.
def wedge_deadline_ms():
    """The effective wedge deadline: 20000, an override, or 0 (disabled)."""
    raw = os.environ.get('DSH_CUA_MCP_WEDGE_DEADLINE_MS', '')
    text = (raw or '').strip()
    if not text:
        return WEDGE_DEFAULT_MS
    try:
        value = int(text)
    except (TypeError, ValueError):
        note('DSH_CUA_MCP_WEDGE_DEADLINE_MS=%r is not a number; using %d'
             % (raw, WEDGE_DEFAULT_MS))
        return WEDGE_DEFAULT_MS
    if value == 0:
        return 0                      # the documented kill switch
    if value < 200:
        return 200                    # below one tick: nothing to measure
    if value > 600000:
        return 600000                 # 10 minutes: a fence, not a policy
    return value


def interval_env(name, default):
    """One interval override; blank/garbage -> default, 0 -> disabled."""
    raw = os.environ.get(name, '')
    text = (raw or '').strip()
    if not text:
        return default
    try:
        value = int(text)
    except (TypeError, ValueError):
        note('%s=%r is not a number; using %d' % (name, raw, default))
        return default
    if value <= 0:
        return 0
    return value


def _suspect_key(facts):
    """The four facts that decide suspect/healthy, or None when healthy.

    A tuple (not a bool) because the loop backs off only on CONSECUTIVE
    IDENTICAL suspect results: a guest that flips between two broken states is
    still changing, and is still worth a fast retry.
    """
    data = facts if isinstance(facts, dict) else {}
    key = (data.get('measured'), data.get('win32ui'), data.get('uiaLane'),
           data.get('workDirWritable'))
    for value in key:
        if value is not True:
            return key
    return None


def facts_refresh_interval(facts):
    """The effective facts refresh interval for these (just measured) facts.

    PURE: no clock, no IO, no global state beyond the env overrides - so the
    host can assert the ladder without a guest. `0` means "no loop".
    """
    if _suspect_key(facts) is None:
        return interval_env('DSH_CUA_MCP_FACTS_FULL_REFRESH_MS',
                            FACTS_FULL_REFRESH_MS)
    return interval_env('DSH_CUA_MCP_FACTS_REFRESH_MS', FACTS_REFRESH_MS)


# --------------------------------------------------------------------------- #
# byte plumbing: raw, exact, EOF-preserving
# --------------------------------------------------------------------------- #
def write_all(fd, data):
    """Write every byte to a fd (short writes / EINTR are real on pipes)."""
    view = memoryview(data)
    while len(view):
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        except OSError:
            return False
        if written <= 0:
            return False
        view = view[written:]
    return True


def read_fd(fd, size=CHUNK):
    """One raw read. b'' means EOF, not 'no data yet'."""
    while True:
        try:
            return os.read(fd, size)
        except InterruptedError:
            continue
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            return b''


def close_socket(sock):
    """Half-close then close; a doubled close is not an error."""
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# interpreter / child command
# --------------------------------------------------------------------------- #
def is_windowsapps_alias(path):
    """True for the Microsoft Store App Execution Alias directory.

    `...\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe` is a 0-byte stub
    that opens the Store instead of running Python; spawning it from a task
    produces a child that dies before it can read one JSON-RPC byte. The guest
    provisioning's Get-RealPython excludes exactly this prefix, so the relay
    applies the same rule - on both path separators and case-insensitively.
    """
    if not path:
        return False
    normal = '\\' + path.replace('/', '\\')
    return '\\windowsapps\\' in normal.lower()


def resolve_python():
    """The SAME interpreter rule the guest provisioning uses: a real python,
    never the WindowsApps alias.

    PATH directories are filtered BEFORE the search (Get-RealPython parity), so
    a Store stub earlier on PATH cannot shadow a real interpreter later on it;
    only then does shutil.which get a say, and sys.executable is the floor.
    """
    names = ('python.exe', 'python') if os.name == 'nt' else ('python3', 'python')
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        directory = directory.strip().strip('"')
        if not directory or is_windowsapps_alias(directory):
            continue
        for name in names:
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate) and not is_windowsapps_alias(candidate):
                return candidate
    found = shutil.which('python')
    if found and not is_windowsapps_alias(found):
        return found
    return sys.executable or 'python'


def child_argv():
    """['python', '-m', 'dsh_cua.server', '--stdio'], overridable for tests."""
    raw = os.environ.get('DSH_CUA_MCP_SERVER', '').strip()
    if raw:
        try:
            parts = shlex.split(raw)
        except ValueError:
            parts = raw.split()
    else:
        parts = DEFAULT_SERVER.split()
    if not parts:
        parts = DEFAULT_SERVER.split()
    # A bare `python` in the override means "the interpreter this guest has".
    if parts[0] in ('python', 'python.exe'):
        parts[0] = resolve_python()
    return parts


def spawn_child(argv):
    """Start the MCP server; pipes only, no console, no pty."""
    kwargs = {
        'stdin': subprocess.PIPE,
        'stdout': subprocess.PIPE,
        # stderr is NOT the MCP stream: inherit it when the relay has one
        # (server tracebacks land in the task's log), else send it to NUL,
        # which is the pythonw.exe case.
        'stderr': None if sys.stderr is not None else subprocess.DEVNULL,
        # bufsize=0: nothing is buffered in this process, so a byte read from
        # the client is a byte written to the child's pipe and no further.
        'bufsize': 0,
        'close_fds': True,
    }
    if os.name == 'nt':
        kwargs['creationflags'] = CREATE_NO_WINDOW
    try:
        return subprocess.Popen(argv, **kwargs)
    except Exception as exc:
        event('child-spawn-failed', '%s: %s' % (' '.join(argv), exc))
        note('cannot start the MCP server (%s): %s' % (' '.join(argv), exc))
        return None


# --------------------------------------------------------------------------- #
# desktop facts: measured by the token that actually runs the tools
# --------------------------------------------------------------------------- #
def utc_now():
    """Appendix B's `at`: UTC, whole seconds, one spelling."""
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def remaining(deadline):
    """Seconds left in the measurement budget, or None when unbounded.

    The contract bounds the WHOLE self-check at one 20 s window, not each of
    its four children: a guest whose interpreter hangs must not hold the pass
    for 4 x 20 s.
    """
    if deadline is None:
        return None
    left = deadline - time.time()
    return left if left > 0 else 0.0


def short_error(exc, limit=160):
    """One-line form of an exception, for a JSON field that must stay small."""
    text = str(exc)
    name = type(exc).__name__
    line = '%s: %s' % (name, text) if text else name
    return line.replace('\r', ' ').replace('\n', ' ')[:limit]


def probe_child(argv, timeout=FACTS_PROBE_TIMEOUT):
    """Run ONE short-lived diagnostic child: captured, bounded, never raises.

    Deliberately NOT spawn_child: the MCP child is a long-lived byte pipe whose
    stdio IS the session, while a probe must inherit neither end of the bridge
    (a probe that wrote to fd 1 would corrupt the JSON-RPC stream). So stdin is
    NUL, both outputs are captured as text, and a timeout kills the child
    instead of wedging the caller.

    Returns (rc, out, err). rc == -1 means the child never started, which a
    caller must not confuse with "started and failed".
    """
    if not argv:
        return (-1, '', 'empty argv')
    kwargs = {
        'stdin': subprocess.DEVNULL,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.PIPE,
        'timeout': timeout,
        'close_fds': True,
        # Text with a replacement policy: a traceback full of the guest's ANSI
        # code page must never raise a UnicodeDecodeError inside a probe.
        'universal_newlines': True,
        'errors': 'replace',
    }
    if os.name == 'nt':
        kwargs['creationflags'] = CREATE_NO_WINDOW
    try:
        proc = subprocess.run(list(argv), **kwargs)
    except subprocess.TimeoutExpired:
        return (-9, '', 'timeout after %s s' % (timeout,))
    except Exception as exc:
        return (-1, '', short_error(exc))
    out = proc.stdout if isinstance(proc.stdout, str) else ''
    err = proc.stderr if isinstance(proc.stderr, str) else ''
    code = proc.returncode
    return (-1 if code is None else code, out, err)


def run_python_probe(python, code, errors, label, timeout=FACTS_PROBE_TIMEOUT,
                     deadline=None):
    """One bounded `python -c` in the interpreter that runs the server.

    Returns (ok, ran, out, err). `ran` separates "this interpreter cannot be
    started" (a host/payload problem) from "the import failed" (the measured
    dead lane the tools hit), and the failure reason is appended to `errors` so
    the facts file explains itself instead of reporting a bare boolean.
    """
    if not python:
        errors.append('%s: no interpreter' % (label,))
        return (False, False, '', 'no interpreter')
    budget = remaining(deadline)
    if budget is not None and budget <= 0:
        errors.append('%s: the %d s budget was spent before this probe'
                      % (label, FACTS_PROBE_TIMEOUT))
        return (False, False, '', 'budget spent')
    if budget is not None:
        timeout = max(0.1, min(timeout, budget))
    rc, out, err = probe_child([python, '-c', code], timeout=timeout)
    if rc == -1:
        errors.append('%s: cannot start %s (%s)' % (label, python, err))
        return (False, False, out, err)
    if rc != 0:
        detail = [line.strip() for line in (err or out or '').splitlines() if line.strip()]
        errors.append('%s: %s' % (label, detail[-1] if detail else 'exit %d' % (rc,)))
    return (rc == 0, True, out, err)


def last_json_object(text):
    """The LAST JSON object in a captured stream, or None.

    A probe's stdout can carry an interpreter banner before the one line that
    matters; the file readers (host side) apply the same rule.
    """
    if not text:
        return None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith('{') and line.endswith('}'):
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None


def current_user():
    """The account the desktop token runs as; never empty when the OS knows it.

    A scheduled task can be started with a trimmed environment, so the env vars
    are a fast path and getpass is the floor - the field is what a JURY report
    reads to prove WHICH token measured the rest.
    """
    for name in ('USERNAME', 'USER'):
        value = (os.environ.get(name) or '').strip()
        if value:
            return value
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return ''


def profile_root():
    """The logged-on user's profile root: the measured contrast, not the fix.

    A Medium-integrity desktop token cannot write here on the shipped guest,
    which is exactly why the work directory exists; reporting it keeps that
    fact visible instead of assumed.
    """
    if os.name == 'nt':
        return (os.environ.get('USERPROFILE') or '').strip()
    return (os.environ.get('HOME') or '').strip()


def current_session_id():
    """The Windows session this process lives in (2 is the desktop), or None.

    ctypes only on Windows: this is a fact about the guest, and on a Linux host
    (where the pump is exercised) there is nothing to report.
    """
    if os.name != 'nt':
        return None
    try:
        import ctypes
        value = ctypes.c_ulong(0)
        answered = ctypes.windll.kernel32.ProcessIdToSessionId(
            ctypes.c_ulong(os.getpid()), ctypes.byref(value))
        return int(value.value) if answered else None
    except Exception:
        return None


def write_probe(directory, errors=None, label='write'):
    """Write-then-delete one byte file as THIS token. Both halves must work.

    A create that cannot be removed is not writability: the next probe would
    meet a file it did not make. Anything left behind is cleaned up quietly so
    a failed measurement never becomes the next measurement's false positive.
    """
    if not directory:
        if errors is not None:
            errors.append('%s: no directory' % (label,))
        return False
    path = os.path.join(directory, WRITE_PROBE_NAME)
    try:
        handle = open(path, 'wb')
        try:
            handle.write(b'ok')
        finally:
            handle.close()
    except Exception as exc:
        if errors is not None:
            errors.append('%s: %s' % (label, short_error(exc)))
        return False
    try:
        os.remove(path)
    except Exception as exc:
        if errors is not None:
            errors.append('%s: wrote but cannot delete (%s)' % (label, short_error(exc)))
        try:
            os.remove(path)
        except Exception:
            pass
        return False
    return True


def measure_scale_fix(python, errors, deadline=None):
    """'applied' when the INSTALLED bridge.py carries the corrected ratios.

    A source read, exactly as Appendix B asks: the D3 patch names its own crop
    size (`base_w`), so its presence in the module the server imports IS the
    fact. Nothing here re-runs the patch or trusts the firstboot marker - an
    unpatched or absent module is reported as `skipped:<why>`, never as
    `applied`.
    """
    ok, ran, out, _err = run_python_probe(python, SCALE_PROBE, errors, 'scaleFix',
                                           deadline=deadline)
    if not ran:
        return 'unverified:no interpreter'
    if not ok:
        # The distribution is not importable in this interpreter (or not
        # installed at all): the patched file cannot be checked.
        return 'skipped:no-file'
    lines = [line.strip() for line in (out or '').splitlines() if line.strip()]
    origin = lines[-1] if lines else ''
    if not origin or not origin.lower().endswith('.py') or not os.path.isfile(origin):
        # Nothing installed, or nothing that is a source file: the patched
        # function cannot be checked, so claiming any state would be a guess.
        return 'skipped:no-file'
    try:
        handle = open(origin, 'rb')
        try:
            source = handle.read(2 * 1024 * 1024).decode('utf-8', 'replace')
        finally:
            handle.close()
    except Exception as exc:
        errors.append('scaleFix: %s' % (short_error(exc),))
        return 'unverified:unreadable source'
    return 'applied' if 'base_w' in source else 'skipped:anchor'


def facts_temp_dir():
    """`%TEMP%` (the documented fallback), else the platform temp directory."""
    for name in ('TEMP', 'TMP'):
        value = (os.environ.get(name) or '').strip().strip('"')
        if value and os.path.isdir(value):
            return value
    try:
        directory = tempfile.gettempdir()
    except Exception:
        return ''
    return directory if directory and os.path.isdir(directory) else ''


def empty_facts():
    """Every Appendix B key, with unknown values (measured stays false)."""
    return {
        'schema': DESKTOP_FACTS_SCHEMA,
        'measured': False,
        'at': utc_now(),
        'user': current_user(),
        'session': current_session_id(),
        'python': '',
        'dshCuaVersion': '',
        'pywin32Version': '',
        'win32ui': False,
        'uiaLane': False,
        'scaleFix': 'unverified:not measured',
        'workDir': WORK_DIR,
        'workDirWritable': False,
        'profileRootWritable': False,
        'source': '',
        'error': '',
    }


def write_desktop_facts(facts):
    """Write the one JSON object where the client looks. Returns (path, source).

    The work directory is the documented home; `%TEMP%` is the fallback that
    must work precisely when the work-dir probe just failed - a guest whose
    DACL is wrong still has to be able to SAY so. Never raises: a measurement
    that cannot be published is logged by the caller, not thrown at a thread.
    """
    candidates = (
        (os.path.join(WORK_DIR, DESKTOP_FACTS_NAME) if WORK_DIR else '', 'cua-work'),
        (os.path.join(facts_temp_dir(), DESKTOP_FACTS_NAME), 'temp'),
    )
    for path, source in candidates:
        parent = os.path.dirname(path) if path else ''
        if not path or not parent or not os.path.isdir(parent):
            continue
        facts['source'] = source
        try:
            payload = json.dumps(facts, ensure_ascii=True, sort_keys=True)
        except Exception:
            facts['source'] = 'none'
            return ('', 'none')
        # ATOMIC, BECAUSE THE READER IS ON A TIMER. The host polls this file
        # while the loop rewrites it; a plain open('w') truncates first, so a
        # reader that arrives in that window reads half an object and reports
        # "the guest said nothing" on a guest that is answering fine. Temp file
        # in the SAME directory (so replace stays a rename) then os.replace.
        temp_path = None
        try:
            handle = tempfile.NamedTemporaryFile(
                mode='w', dir=parent, delete=False,
                prefix=DESKTOP_FACTS_NAME + '.', suffix='.tmp')
            temp_path = handle.name
            try:
                handle.write(payload + '\n')
                handle.flush()
                os.fsync(handle.fileno())
            finally:
                handle.close()
            os.replace(temp_path, path)
            temp_path = None
        except Exception:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
            continue
        return (path, source)
    facts['source'] = 'none'
    return ('', 'none')


def collect_desktop_facts(deadline=None):
    """Measure Appendix B in ONE pass bounded by a single 20 s budget.

    Callers must be ready for a raise (publish_desktop_facts turns one into a
    written failure file): a measurement that cannot even start must still be
    a file the host can read, because "the guest said nothing" and "the guest
    said it is blind" are different diagnoses.
    """
    if deadline is None:
        deadline = time.time() + FACTS_PROBE_TIMEOUT
    errors = []
    facts = empty_facts()
    python = resolve_python()
    facts['python'] = python or ''

    ok, version_ran, out, _err = run_python_probe(
        python, VERSION_PROBE, errors, 'versions', deadline=deadline)
    if ok:
        parsed = last_json_object(out)
        if isinstance(parsed, dict):
            facts['dshCuaVersion'] = str(parsed.get('dsh-cua') or '')
            facts['pywin32Version'] = str(parsed.get('pywin32') or '')
        else:
            errors.append('versions: unparseable answer')

    facts['win32ui'], ui_ran, _ui_out, _ui_err = run_python_probe(
        python, 'import win32ui', errors, 'win32ui', deadline=deadline)
    facts['uiaLane'], uia_ran, _uia_out, _uia_err = run_python_probe(
        python, 'import pywinauto.controls.uiawrapper', errors, 'uiaLane',
        deadline=deadline)
    facts['scaleFix'] = measure_scale_fix(python, errors, deadline=deadline)
    facts['workDirWritable'] = write_probe(WORK_DIR, errors, 'workDir')
    facts['profileRootWritable'] = write_probe(profile_root(), errors, 'profileRoot')

    # measured is TRUE only when the interpreter answered all three lane
    # questions. A probe that never ran (no interpreter, budget spent) means the
    # lane is UNKNOWN, and the consumer contract reads measured:false as "every
    # field unknown" - reporting it as a measured dead lane instead would be the
    # same class of lie this contract removes.
    lane = (('versions', version_ran), ('win32ui', ui_ran), ('uiaLane', uia_ran))
    facts['measured'] = all(ran for _label, ran in lane)
    if not facts['measured']:
        silent = ', '.join(label for label, ran in lane if not ran)
        errors.append('not measured (%s did not run in %s)'
                      % (silent, python or 'no interpreter'))
    facts['error'] = '; '.join(errors)[:600]
    return facts


def publish_desktop_facts(relay=None):
    """Measure once, publish once, log once. Never raises, never blocks a pump.

    Runs in its own daemon thread, started AFTER the listener binds, so the
    bridge is already accepting sessions while this measures. Local to the
    guest, bounded by FACTS_PROBE_TIMEOUT, sharing no state with the pumps.

    `relay` is optional and exists so the ONE caller that owns the live
    counters can publish them: the host reads `relay` out of this file instead
    of paying an SSH round trip for the same numbers. It also carries
    `refreshMs`, the interval this measurement just earned - the reader needs
    it to tell an honest 15-minute refresh from a dead writer.
    """
    started = time.time()
    try:
        facts = collect_desktop_facts()
    except Exception as exc:
        facts = empty_facts()
        facts['error'] = 'collect: %s' % (short_error(exc),)
    evidence = {}
    if relay is not None:
        try:
            evidence = relay.evidence()
        except Exception as exc:
            evidence = {'error': short_error(exc)}
    facts['relay'] = evidence
    facts['refreshMs'] = facts_refresh_interval(facts)
    try:
        path, source = write_desktop_facts(facts)
    except Exception as exc:
        path, source = ('', 'none')
        facts['source'] = 'none'
        facts['error'] = ('%s; write: %s' % (facts.get('error', ''),
                                             short_error(exc))).strip('; ')[:600]
    elapsed = time.time() - started
    event('desktop-facts', 'measured=%s source=%s win32ui=%s uiaLane=%s '
          'scaleFix=%s workDirWritable=%s profileRootWritable=%s '
          'refreshMs=%s elapsed=%.2fs path="%s" error="%s"' % (
              'true' if facts.get('measured') else 'false',
              source or 'none',
              'true' if facts.get('win32ui') else 'false',
              'true' if facts.get('uiaLane') else 'false',
              facts.get('scaleFix') or '',
              'true' if facts.get('workDirWritable') else 'false',
              'true' if facts.get('profileRootWritable') else 'false',
              facts.get('refreshMs'),
              elapsed,
              path,
              (facts.get('error') or '')[:200],
          ))
    return facts


# --------------------------------------------------------------------------- #
# probe classification + passive id pairing (pure, so both are testable)
# --------------------------------------------------------------------------- #
def _probe_kind(buffered):
    """'ping' | 'functional' | None (None == a real session's first bytes)."""
    for token, kind in PROBES:
        if buffered == token:
            return kind
    return None


def _probe_prefix(buffered):
    """True while `buffered` could still grow into SOME probe token."""
    if not buffered:
        return True
    if PROBE_PING.startswith(buffered):
        return True
    return PROBE_FN.startswith(buffered)


def _is_json_id(value):
    """A JSON-RPC id: int or str. `True`/`False` are ints in Python, not ids."""
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or isinstance(value, str)


def _id_order(value):
    """Sort key for mixed int/str ids: numeric first, then lexicographic."""
    return (0, value) if isinstance(value, int) else (1, str(value))


def _json_object(line):
    """One parsed JSON object from a raw line, or None (never raises)."""
    if not line:
        return None
    try:
        message = json.loads(line)
    except Exception:
        return None
    return message if isinstance(message, dict) else None


def _request_id(line):
    """The id of a JSON-RPC REQUEST on this line, or None.

    A notification has no `id` and is not tracked; a response is not outbound.
    Anything that is not a JSON object is forwarded and pairs nothing.
    """
    message = _json_object(line)
    if message is None:
        return None
    if not isinstance(message.get('method'), str):
        return None
    if 'id' not in message:
        return None
    value = message.get('id')
    return value if _is_json_id(value) else None


class LineScan(object):
    """A capped newline buffer over a byte stream this process ALREADY bridged.

    Passive by construction: the pump hands it a copy after the write, and
    `feed` can only return lines.

    A LINE CAN LEGITIMATELY BE BIGGER THAN THE CAP. An MCP server answers
    `capture_window`/`get_text` with multi-megabyte results, and on one line -
    so "the buffer passed SCAN_CAP" is a fact about OUR memory budget, not about
    the child being slow or broken. The scan therefore DROPS the over-long line
    and then RESYNCS at its newline: the fragments of the dropped line are never
    handed back as if they were a line of their own (the old behaviour, which
    made the response unparsable and its request id age forever). `overflows`
    counts every drop so the caller can degrade pairing HONESTLY - "we cannot
    say which id this answered" - instead of letting the watchdog read our own
    bookkeeping as a wedge.
    """

    def __init__(self, cap=SCAN_CAP):
        self.cap = cap
        self.buffer = b''
        # inside the tail of a line we already dropped: skip to its newline
        self.resyncing = False
        # every drop, monotonically: the caller compares before/after `feed`
        self.overflows = 0
        # the last few dropped lengths, for the one log line (bounded)
        self.dropped = []

    def reset(self):
        self.buffer = b''
        self.resyncing = False

    def feed(self, chunk):
        """Complete lines (without the newline) found in this chunk."""
        if not chunk:
            return []
        data = chunk
        if self.resyncing:
            cut = data.find(b'\n')
            if cut < 0:
                return []                 # still inside the dropped line
            data = data[cut + 1:]
            self.resyncing = False
        try:
            self.buffer += data
        except Exception:
            self.buffer = b''
            return []
        lines = []
        while True:
            cut = self.buffer.find(b'\n')
            if cut < 0:
                break
            line = self.buffer[:cut]
            self.buffer = self.buffer[cut + 1:]
            if len(line) > self.cap:
                # Complete, but too big to have been held inside the budget:
                # drop it like the incomplete case (the relay's 64 KiB reads
                # make this branch reachable only from a direct caller).
                self.overflows += 1
                self.dropped = (self.dropped + [len(line)])[-8:]
                continue
            lines.append(line)
        if len(self.buffer) > self.cap:
            # An INCOMPLETE line past the cap: drop it and resync, so its tail
            # is never parsed as a line of its own.
            self.dropped = (self.dropped + [len(self.buffer)])[-8:]
            self.buffer = b''
            self.resyncing = True
            self.overflows += 1
        return lines


# --------------------------------------------------------------------------- #
# --serve
# --------------------------------------------------------------------------- #
class Relay(object):
    """The listener and its ONE shared child.

    WHY THE CHILD OUTLIVES A CLIENT: an MCP client over SSH exits when the
    harness disconnects, but the server it was talking to owns the interactive
    session's windows; tearing it down on every reconnect would throw away
    whatever the desktop is mid-way through and pay a fresh pywinauto warm-up
    each time. So a client disconnect detaches, and the child is reused by the
    next client. A child that DIED is restarted for the next client - and its
    death is noticed by the reader thread, not by a poll, so the client sees
    EOF immediately instead of a silent hang.
    """

    def __init__(self, port):
        self.port = port
        self.proc = None
        self.client = None
        self.lock = threading.Lock()          # one client at a time
        self.proc_lock = threading.Lock()     # guards self.proc / self.client
        self.reader = None
        # REQUEST ACCOUNTING (R2). `pending` maps a request id to the monotonic
        # moment it was forwarded; a response pops it. It is the ONLY thing the
        # watchdog reads, and it is written AFTER the bytes are on their way.
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.child_pid = None
        self.child_restarts = 0
        self.spawn_count = 0
        # A wedge kill already accounts for the restart its own respawn will
        # make; this counter keeps ONE wedge == ONE restart.
        self.wedge_restart_pending = 0
        self.last_success_at = None           # monotonic of the last answer
        self.last_wedge_at = None             # ISO-8601 UTC, for the evidence
        self.busy = False                     # a session holds the lane
        # The pairing buffers. One per direction, per session: the pumps feed
        # them a COPY of bytes they already wrote.
        self.scan_out = LineScan()
        self.scan_in = LineScan()
        # ONE writer at a time on the client socket (J1). Two threads send
        # there - the child reader (result bytes) and the watchdog (the
        # child-wedged answer) - and an unsynchronised sendall can drop the
        # answer INSIDE a partly written result under backpressure, which
        # is one unparsable line carrying two objects and a session the
        # host silently drops. Never held together with proc_lock.
        self.write_lock = threading.Lock()
        self.stop = threading.Event()
        self.wedge_thread = None
        self.facts_thread = None

    # -- child lifecycle ---------------------------------------------------- #
    def child(self):
        """The live child, spawning a replacement if it died.

        A RESPAWN FORGETS THE DEAD CHILD'S REQUESTS. Its unanswered ids belong
        to a process that will never answer them, and leaving them in `pending`
        makes the watchdog read a CRASH as a wedge: 20 s later it kills the
        healthy replacement - which never received those bytes - and writes a
        `child-wedged` error that neither the old child nor the new one ever
        justified. That is the "never kill a healthy child for a bookkeeping
        artifact" invariant, applied to the one path that was still violating it
        (the reader thread's own EOF cleanup misses it whenever a respawn wins
        the race, which is exactly what the pump's heal does).

        The choice is CLEAR, not answer, and the log line says so. Answering
        here would be unsafe, not merely redundant: `_pump_out` replays the very
        chunk that carried those ids to the replacement (the bytes never reached
        a live reader), so the new child answers them FOR REAL - and a second
        answer for one id is a protocol violation, i.e. a duplicate id on the
        wire. With the ids forgotten, `outstandingRequestAgeMs` reports `null`
        (the same honest "not measured" the scan-cap path uses), the replacement
        is never blamed, and a caller whose bytes did reach the dead child sees
        the host's routable `relay-unresponsive` (C6) after its per-call budget
        or the reader's EOF, which is the truth: nobody can say whether that
        call took effect.
        """
        with self.proc_lock:
            proc = self.proc
            if proc is not None and proc.poll() is None:
                return proc
            if proc is not None:
                event('child-exit', 'pid=%d code=%s' % (proc.pid, proc.returncode))
                self.proc = None
            # A new child means a new byte stream in BOTH directions: the
            # mirrors must not carry the dead child's half-lines into the
            # replacement's (a replayed chunk has to parse as the new child
            # saw it). Dropping a tail here can only lose pairing, never a byte.
            self.scan_out.reset()
            self.scan_in.reset()
            # lock order is proc_lock -> pending_lock; the watchdog always
            # releases pending_lock before it touches proc_lock, so this cannot
            # close a cycle.
            dropped = self._drop_pending()
            if dropped:
                event('pending-dropped',
                      'child pid=%s died with %d unanswered id(s): NOT answered '
                      'here (a respawn may replay them to the replacement, and a '
                      'duplicate id is worse than a late timeout) - '
                      'outstandingRequestAgeMs now reports null'
                      % (getattr(proc, 'pid', 'none'), dropped))
            argv = child_argv()
            proc = spawn_child(argv)
            if proc is None:
                return None
            self.proc = proc
            self.child_pid = proc.pid
            # RESTARTS: "re-spawns after the first". Counted HERE, once per
            # spawn, except for the spawn that pays for a watchdog kill - that
            # kill already incremented (C4.6), and double counting one wedge
            # would make the evidence lie about how often the lane died.
            if self.spawn_count > 0:
                if self.wedge_restart_pending > 0:
                    self.wedge_restart_pending -= 1
                else:
                    self.child_restarts += 1
            self.spawn_count += 1
            event('child-start', 'pid=%d %s' % (proc.pid, ' '.join(argv)))
            self.reader = threading.Thread(target=self._read_child, args=(proc,))
            self.reader.daemon = True
            self.reader.start()
            return proc

    def _read_child(self, proc):
        """child stdout -> the attached client. One reader per child, and it
        is authored so a dead child is recorded exactly once."""
        fd = proc.stdout.fileno()
        while True:
            data = read_fd(fd)
            if not data:
                break
            with self.proc_lock:
                client = self.client
            if client is None:
                # Nobody is attached (a reconnect gap): the bytes have no
                # destination. Dropping them is right - an MCP server only
                # speaks on request.
                continue
            # OBSERVE FIRST (J2): the child ANSWERED the moment its bytes reach
            # us, so that is when the id stops being outstanding. Popping after
            # the forward let a client that stopped reading pin a finished call
            # in `pending` for the whole of a blocked sendall - and the watchdog
            # then killed a healthy child that had already executed it.
            responded = self._observe_inbound(data, self.scan_in)
            # FORWARD SECOND, and serialised with the watchdog's answer (J1).
            if not self._send_to_client(client, data):
                close_socket(client)
                with self.proc_lock:
                    if self.client is client:
                        self.client = None
                continue
            if responded:
                # `lastSuccessfulCallAgeMs` keeps its frozen meaning: a response
                # that really left for the client, not merely one we read.
                self._mark_success()
        code = None
        try:
            code = proc.wait(timeout=1)
        except Exception:
            code = proc.poll()
        event('child-exit', 'pid=%d code=%s' % (proc.pid, code))
        # EOF CLEANUP BELONGS TO THE CHILD THAT PRODUCED IT. This reader can
        # notice a death LATE: the client detached, reconnected, and child()
        # already spawned a replacement that the new client is attached to.
        # Closing "whatever self.client is now" would byte-bury a healthy
        # session. So the decision and the close are ordered by proc_lock and
        # gated on self.proc still being THIS child; otherwise the new owner
        # owns the client and this reader only records the exit.
        with self.proc_lock:
            owner = self.proc is proc
            if owner:
                self.proc = None
                # the child that owned this pid is gone: the evidence must not
                # keep reporting a pid nobody can signal.
                self.child_pid = None
                # A client waiting on a dead child must see EOF, not a hang.
                client = self.client
                self.client = None
            else:
                client = None
        if owner:
            # The ids this child never answered are owed to nobody: its client
            # is being closed below (or has already detached). Leaving them in
            # `pending` would arm the watchdog against the NEXT session.
            self._clear_pending()
        if client is not None:
            close_socket(client)

    def stop_child(self):
        with self.proc_lock:
            proc = self.proc
            self.proc = None
        if proc is None:
            return
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # -- desktop facts ------------------------------------------------------ #
    def publish_desktop_facts(self):
        """Thread target for the adaptive self-check (one name, one owner).

        Deliberately thin: `_facts_loop` does the looping and the module-level
        publish_desktop_facts() does the measuring and the logging; this
        wrapper exists so a raise inside either lands in the event log instead
        of killing the thread with a traceback nobody can read (pythonw.exe has
        no stderr).
        """
        self._facts_loop()

    def _facts_loop(self):
        """Re-measure, re-publish, sleep - for the life of the listener (R8).

        The interval comes from the facts JUST published, so a suspect guest is
        re-checked inside a minute and a healthy one is left alone for fifteen.
        FACTS_SUSPECT_MAX consecutive IDENTICAL suspect passes back off to the
        full interval: that is what stops a permanently broken guest from being
        probed every minute forever.
        """
        streak = 0
        previous = None
        while not self.stop.is_set():
            facts = None
            try:
                facts = publish_desktop_facts(self)
            except Exception as exc:
                event('desktop-facts-failed', repr(exc))
            published = facts if isinstance(facts, dict) else {}
            interval = published.get('refreshMs')
            if not isinstance(interval, int):
                interval = facts_refresh_interval(published)
            suspect = _suspect_key(published)
            if suspect is None:
                streak = 0
            elif suspect == previous:
                streak += 1
            else:
                streak = 0
            previous = suspect
            if suspect is not None and streak >= FACTS_SUSPECT_MAX:
                interval = interval_env('DSH_CUA_MCP_FACTS_FULL_REFRESH_MS',
                                        FACTS_FULL_REFRESH_MS)
            if interval <= 0:
                return                    # the documented kill switch
            self._wait_slices(interval)

    def _wait_slices(self, interval_ms):
        """Sleep in WEDGE_TICK_MS slices so stop.set() is noticed promptly."""
        deadline = time.monotonic() + (interval_ms / 1000.0)
        while not self.stop.is_set():
            left = deadline - time.monotonic()
            if left <= 0:
                return
            self.stop.wait(min(left, WEDGE_TICK_MS / 1000.0))

    # -- request accounting and the wedge (R2) ------------------------------ #
    def _clear_pending(self):
        with self.pending_lock:
            self.pending.clear()

    def _drop_pending(self):
        """Forget every outstanding id and return how many there were."""
        with self.pending_lock:
            dropped = len(self.pending)
            self.pending.clear()
        return dropped

    def _pending_oldest_age_ms(self):
        """Age of the OLDEST unanswered request, or None when nothing is out."""
        with self.pending_lock:
            stamps = list(self.pending.values())
        if not stamps:
            return None
        age = int((time.monotonic() - min(stamps)) * 1000)
        return age if age > 0 else 0

    def _last_success_age_ms(self):
        """Age of the last forwarded answer, or None before the first one.

        None is NOT zero: "the child has never answered" and "it answered 0 ms
        ago" are opposite diagnoses, and folding them together is exactly the
        fabricated `0` a reader would trust.
        """
        with self.pending_lock:
            stamp = self.last_success_at
        if stamp is None:
            return None
        age = int((time.monotonic() - stamp) * 1000)
        return age if age > 0 else 0

    def _observe_outbound(self, chunk, scan):
        """Record the ids of the requests in `chunk` (already forwarded).

        PASSIVE: it runs after write_all(), reads a copy, and may only add to
        `pending`. A bug here loses pairing, never a byte.

        An OVERFLOW here is its own fact (J8): the dropped line was a REQUEST,
        so its ids were never registered and can never be watched for a wedge -
        the caller would wait out the host's timer with no guest-side answer. It
        is reported on the same `pairing-degraded` path as the response side,
        but it does NOT clear the pending map: the ids already there were
        observed completely and are still owed their own clocks.
        """
        before = scan.overflows
        try:
            lines = scan.feed(chunk)
        except Exception:
            lines = []
        for line in lines:
            try:
                request = _request_id(line)
                if request is None:
                    continue
                with self.pending_lock:
                    # A resent id is the SAME call still in flight: keep the
                    # older stamp so a wedged call cannot be un-wedged by a
                    # retry that also hangs.
                    if request not in self.pending:
                        self.pending[request] = time.monotonic()
            except Exception:
                continue
        if scan.overflows != before:
            self._pairing_degraded('request', scan, clear=False)

    def _observe_inbound(self, chunk, scan):
        """Pop every answered id in `chunk`; True when the child responded.

        An `error` response pops too: the child ANSWERED. Only silence is a
        wedge. The pop happens HERE, before a byte is forwarded (J2), because a
        blocked client socket must not make a finished call look outstanding.

        An OVERFLOW is not silence: the scan dropped a line longer than its cap,
        so this chunk may well contain the answer to the oldest outstanding id -
        we simply cannot read the id out of it. That is handled by
        `_pairing_degraded()`, never by aging the id into a wedge.
        """
        before = scan.overflows
        responded = False
        try:
            lines = scan.feed(chunk)
        except Exception:
            lines = []
        for line in lines:
            try:
                message = _json_object(line)
                if message is None or 'id' not in message:
                    continue
                key = message.get('id')
                if _is_json_id(key) is False:
                    continue
                # A response we cannot attribute (an id nobody tracked: after a
                # respawn or a cap overflow) still proves the child speaks, so
                # the facts stay honest about it.
                responded = True
                with self.pending_lock:
                    if key in self.pending:
                        del self.pending[key]
            except Exception:
                continue
        if scan.overflows != before:
            self._pairing_degraded('response', scan)
        return responded

    def _mark_success(self):
        """Date the last response that actually left for the client."""
        with self.pending_lock:
            self.last_success_at = time.monotonic()

    def _send_to_client(self, conn, data, timeout=None):
        """Write one WHOLE message to the client, serialised with every other.

        THE ONLY WRITER PATH (J1). The child's reader and the watchdog both
        write to this socket; without the lock an 8 KiB `child-wedged` answer
        can be interleaved into a multi-chunk result under backpressure, giving
        one unparsable line that carries both objects - which the host parses as
        nothing and drops, losing the answer AND the error. `timeout` exists for
        the watchdog: a stalled client must not freeze the thread that polices
        wedges.
        """
        if conn is None:
            return False
        if timeout is None:
            acquired = self.write_lock.acquire(True)
        else:
            acquired = self.write_lock.acquire(True, timeout)
        if not acquired:
            return False
        try:
            conn.sendall(data)
            return True
        except OSError:
            return False
        finally:
            self.write_lock.release()

    def _pairing_degraded(self, direction, scan=None, clear=True):
        """One unreadable line went past the scan cap: say so, honestly.

        INBOUND (`clear=True`, a response): the dropped line may be the answer
        to the oldest outstanding id. The bytes were forwarded - accounting is
        passive - so what is lost is only the ATTRIBUTION. Killing the child
        over that would be the worst trade available (a healthy server
        terminated, its caller told a call that already succeeded is UNKNOWN,
        and a duplicate id on the wire), so those ids stop being "known
        unanswered": the watchdog can no longer fire on them and the host's own
        per-call budget still covers them.

        OUTBOUND (`clear=False`, a request): the dropped line was a REQUEST, so
        its ids were never registered and cannot be watched at all - the honest
        thing is to say that, not to forget the ids of OTHER calls that were
        observed completely and are still in flight.
        """
        dropped = list(getattr(scan, 'dropped', []) or [])
        lost = self._drop_pending() if clear else 0
        if clear:
            detail = ('%d outstanding id(s) are no longer trusted (the bridge '
                      'is unaffected)' % (lost,))
        else:
            detail = ('the call in that line cannot be watched for a wedge '
                      '(pending ids keep their own clocks; the bridge is '
                      'unaffected)')
        event('pairing-degraded',
              'a %s line passed the %d-byte scan cap (dropped lengths=%s): %s'
              % (direction, SCAN_CAP, dropped or 'n/a', detail))

    def evidence(self):
        """The facts-file half of C3: the counters, no lane state.

        `busy`/`attached`/`mode` are RELAY_FN-only by contract: they describe
        the moment a probe asked, and a facts file that is 40 s old must not
        pretend to. `at` dates this read.
        """
        return self._counters()

    def _counters(self):
        """childPid/childRestarts/ages/lastWedgeAt/deadline + `at` (C3)."""
        with self.proc_lock:
            proc = self.proc
            pid = self.child_pid if proc is not None else None
            restarts = self.child_restarts
            last_wedge = self.last_wedge_at
        return {
            'at': utc_now(),
            'childPid': pid,
            'childRestarts': restarts,
            'lastSuccessfulCallAgeMs': self._last_success_age_ms(),
            'outstandingRequestAgeMs': self._pending_oldest_age_ms(),
            'lastWedgeAt': last_wedge,
            'wedgeDeadlineMs': wedge_deadline_ms(),
        }

    def _fn_evidence(self):
        """C3's full answer for the RELAY_FN verb: counters plus lane state."""
        evidence = self._counters()
        with self.proc_lock:
            attached = self.client is not None
            busy = self.busy
        evidence['mode'] = 'functional'
        evidence['busy'] = bool(busy)
        evidence['attached'] = bool(attached)
        return evidence

    def _answer_fn(self, conn):
        """Answer the RELAY_FN evidence verb: ONE JSON line, then the caller closes.

        Answered before the session lock (see handle()), so evidence about the
        lane stays readable WHILE the lane is in use. It never spawns a child
        and never signals one: reading the counters must not change them.
        """
        try:
            payload = json.dumps(self._fn_evidence(), ensure_ascii=True,
                                 sort_keys=True)
        except Exception as exc:
            # A broken evidence object is still an ANSWER: the host parses one
            # line and reports `no-evidence` on a missing one, which would blame
            # the transport for a bug here.
            payload = json.dumps({'mode': 'functional',
                                  'error': short_error(exc)},
                                 ensure_ascii=True, sort_keys=True)
        try:
            conn.sendall(payload.encode('ascii') + b'\n')
        except OSError:
            pass
        event('fn-probe', 'answered RELAY_FN')

    def _kill_wedged_child(self, proc, age_ms=None):
        """Kill a wedged child and hand back its pid (TerminateProcess).

        `self.proc` is cleared BEFORE the kill so the dying child's own reader
        cannot mistake the EOF it is about to see for "my client is gone" and
        close the session this whole path exists to save.
        """
        if proc is None:
            return None
        with self.proc_lock:
            if self.proc is proc:
                self.proc = None
            self.child_pid = None
            self.wedge_restart_pending += 1
            pid = proc.pid
        try:
            proc.kill()
        except Exception as exc:
            note('cannot kill wedged child pid=%s (%s)' % (pid, exc))
        event('child-killed', 'pid=%d age=%s' % (pid, age_ms))
        return pid

    def _answer_wedged(self, ids, age_ms, pid):
        """Answer every pending id, ascending, once - and close nothing.

        The ids are answered in the ORDER the client sent them, on the SAME
        socket it is already reading, because the client's own timer is behind
        this one and a re-connect would lose the session the wedge just saved.
        """
        # BOOK FIRST (J3). The kill already happened, so the counters describe a
        # fact - and they must be readable WHILE the answers are still being
        # written: a client that stopped reading used to block these sends and
        # leave the doctor with `childRestarts:0` / `lastWedgeAt:null` next to a
        # `child-killed` log line, i.e. "no wedge ever happened".
        # Nothing killed (`pid is None`) means nothing restarted, so nothing is
        # booked (J7): otherwise the count inflates without a spawn to pay for.
        if pid is not None:
            with self.proc_lock:
                self.child_restarts += 1
                self.last_wedge_at = utc_now()
        with self.proc_lock:
            client = self.client
            restarts = self.child_restarts
        for index, call_id in enumerate(ids):
            # CLAIM THE ID UNDER THE SAME LOCK THE RESPONSE PATH USES (J7). If
            # the child answered this id while the watchdog was killing it, the
            # id is already gone - and a second answer for one id is a duplicate
            # on the wire, which C4.5 forbids and the host drops silently.
            with self.pending_lock:
                if call_id not in self.pending:
                    continue
                del self.pending[call_id]
            message = ('child-wedged: the MCP server did not answer in %d ms; '
                       'killed pid %s (restart #%d); the call did not return, '
                       'so its effect is UNKNOWN - re-observe before retrying'
                       % (age_ms,
                          pid if pid is not None else 'unknown',
                          restarts))
            line = json.dumps({
                'jsonrpc': '2.0',
                'id': call_id,
                'error': {'code': WEDGE_ERROR_CODE, 'message': message},
            }, ensure_ascii=True) + '\n'
            if client is None:
                continue
            if not self._send_to_client(client, line.encode('ascii'),
                                        timeout=WEDGE_ANSWER_TIMEOUT):
                # The client is not taking bytes. Its callers cannot be reached
                # at all, so the remaining ids are dropped rather than re-fired
                # every tick (which would spam `wedge` forever).
                with self.pending_lock:
                    for other in ids[index:]:
                        self.pending.pop(other, None)
                event('wedge-answer-skipped',
                      'client stopped accepting bytes; %d id(s) unanswered'
                      % (len(ids) - index))
                break

    def start_wedge_watch(self):
        """Start the watchdog (only when the deadline is on)."""
        if wedge_deadline_ms() <= 0:
            return None
        thread = threading.Thread(target=self._wedge_watch, name='wedge-watch')
        thread.daemon = True
        thread.start()
        self.wedge_thread = thread
        return thread

    def _wedge_watch(self):
        """The one thing that turns a wedged call into a coded error.

        Order is the contract: log the wedge, KILL, then answer. A client that
        saw the answer before the child was dead could immediately retry into
        the same wedged process.
        """
        while not self.stop.wait(WEDGE_TICK_MS / 1000.0):
            try:
                deadline = wedge_deadline_ms()
                if deadline <= 0:
                    continue
                with self.pending_lock:
                    if not self.pending:
                        continue
                    oldest = min(self.pending.values())
                    ids = sorted(self.pending.keys(), key=_id_order)
                age_ms = int((time.monotonic() - oldest) * 1000)
                if age_ms < deadline:
                    continue
                proc = self._child_ref()
                event('wedge', 'id=%s age=%d child=%s'
                      % (ids[0], age_ms, proc.pid if proc is not None else 'none'))
                pid = self._kill_wedged_child(proc, age_ms)
                self._answer_wedged(ids, age_ms, pid)
            except Exception as exc:
                event('wedge-error', repr(exc))

    def _child_ref(self):
        with self.proc_lock:
            return self.proc

    # -- classification ----------------------------------------------------- #
    def classify(self, conn):
        """('probe', None) | ('session', preamble) | ('drop', None).

        Reading is PREFIX-AWARE, over the TOKEN SET: bytes are accumulated only
        while they could still become one of the probe tokens, the buffer is
        answered the moment it EQUALS one, and the first byte that matches no
        token hands the whole buffer back untouched as a real session - nothing
        is consumed from a client.
        """
        buffered = b''
        longest = max(len(token) for token, _kind in PROBES)
        deadline = time.time() + PROBE_WINDOW
        while True:
            if buffered:
                kind = _probe_kind(buffered)
                if kind is not None:
                    self._answer_probe(conn, kind)
                    return ('probe', None)
                if not _probe_prefix(buffered):
                    return ('session', buffered)     # diverged: a real session
            remaining = deadline - time.time()
            if remaining <= 0:
                if not buffered:
                    return ('drop', None)            # connected, said nothing
                return ('session', buffered)
            try:
                conn.settimeout(remaining)
                chunk = conn.recv(4096)
            except socket.timeout:
                if not buffered:
                    return ('drop', None)
                return ('session', buffered)
            except OSError:
                return ('drop', None)
            if not chunk:
                if not buffered:
                    return ('drop', None)
                return ('session', buffered)
            buffered += chunk
            if len(buffered) > longest:
                return ('session', buffered)        # cannot be a probe any more

    def _answer_probe(self, conn, kind):
        """Answer one probe token. 'ping' is unchanged; 'functional' is C3."""
        if kind == 'functional':
            self._answer_fn(conn)
            return
        try:
            conn.sendall(PROBE_OK)
        except OSError:
            pass
        event('ping', 'answered RELAY_OK')

    # -- one session -------------------------------------------------------- #
    def serve_client(self, conn, preamble):
        proc = self.child()
        if proc is None:
            event('connect-failed', 'no MCP server child')
            return
        with self.proc_lock:
            self.client = conn
            self.busy = True
        self.scan_out.reset()
        self.scan_in.reset()
        event('connect', 'client -> child pid=%d' % proc.pid)
        try:
            if preamble:
                forwarded = self._pump_out(proc, preamble)
                if forwarded is None:
                    event('write-failed', 'preamble')
                    return
                proc = forwarded
                self._observe_outbound(preamble, self.scan_out)
            # THIS thread is one of the two pumps: client -> child. The other is
            # the child reader above. Raw reads, no framing, no buffering.
            while True:
                try:
                    data = conn.recv(CHUNK)
                except InterruptedError:
                    continue
                except OSError:
                    data = b''
                if not data:
                    break
                forwarded = self._pump_out(proc, data)
                if forwarded is None:
                    event('write-failed', 'no child to heal the lane')
                    break
                proc = forwarded
                self._observe_outbound(data, self.scan_out)
        finally:
            with self.proc_lock:
                if self.client is conn:
                    self.client = None
                self.busy = False
            # Ids this session's child never answered die with the session: no
            # client is attached to receive the answers, and leaving them in
            # `pending` would arm the watchdog against the NEXT session.
            self._clear_pending()
            # ...and the state is read NOW, not from the child this session
            # STARTED with: a wedge replaces it mid-session, and a log line that
            # reports the killed pid as "kept" misleads the next reader.
            current = self._child_ref() or proc
            state = ('kept' if current.poll() is None
                     else 'died; the next client restarts it')
            event('disconnect', 'client detached (child pid=%d %s)'
                  % (current.pid, state))

    def _pump_out(self, proc, data):
        """Forward one chunk to the live child, healing past a wedge kill.

        THE RACE THIS CLOSES: the pump used to check `proc.poll()` and THEN
        write. The watchdog can kill the child in the window between the two -
        it clears `self.proc` before the kill - so the write failed on a dead
        pipe, the pump `break`ed, and the client socket was closed. That is the
        exact opposite of both promises this design makes: "the client socket is
        never closed" and "the lane heals in place". A dead fd is not the end of
        a session, it is the IDENTITY OF THE CHILD CHANGING.

        So: write only to a child that is alive; if that fails or the child is
        already gone, respawn and replay the SAME chunk (the bytes never reached
        a live reader, so replay is exactly-once for whoever reads the pipe now),
        bounded to three children - a lane that cannot be spawned still ends the
        session instead of spinning.

        Returns the child the bytes actually went to, or None.
        """
        for _attempt in range(3):
            if proc is not None and proc.poll() is None:
                try:
                    fd = proc.stdin.fileno()
                except Exception:
                    fd = None
                if fd is not None and write_all(fd, data):
                    return proc
            # The poll/write window lost, or the child died: the client is still
            # attached and still owed an answer, so a fresh child serves the
            # SAME socket. Dropping the session here is the defect the
            # child-wedged answer exists to remove.
            fresh = self.child()
            if fresh is None:
                return None
            proc = fresh
        return None

    def handle(self, conn):
        try:
            kind, preamble = self.classify(conn)
            if kind == 'probe':
                return
            if kind == 'drop':
                event('connect-idle', 'closed before a session started')
                return
            # classify() leaves a short timeout on the socket; the session
            # pump must BLOCK (a timeout there would read as EOF and drop a
            # live client the moment it is quiet).
            conn.settimeout(None)
            # The probe took no lock, so a health check is never queued behind
            # a live session; a SECOND session waits here for the first.
            with self.lock:
                self.serve_client(conn, preamble)
        except Exception as exc:
            event('session-error', repr(exc))
        finally:
            close_socket(conn)

    # -- listener ----------------------------------------------------------- #
    def run(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # BIND MUST BE EXCLUSIVE ON WINDOWS. SO_REUSEADDR there is not
            # "skip TIME_WAIT" as on POSIX: it lets a SECOND --serve bind the
            # same 127.0.0.1:47999 and the kernel then splits incoming clients
            # between the two listeners. Two relays means half the sessions talk
            # to the relay whose child never saw the interactive session (or to
            # a stale child), which looks exactly like a flaky desktop.
            # SO_EXCLUSIVEADDRUSE is the Windows option that makes the second
            # bind fail loudly - and the bind-failure path below already logs
            # listen-failed and exits 1. POSIX keeps SO_REUSEADDR, where it
            # genuinely only reclaims a TIME_WAIT port.
            if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            # LOOPBACK ONLY. Anything wider would let the LAN (and the VM's
            # host bridge) drive the desktop; the SSH channel is the door.
            listener.bind((LOOPBACK, self.port))
            listener.listen(8)
        except OSError as exc:
            event('listen-failed', 'port=%d %s' % (self.port, exc))
            note('cannot listen on %s:%d (%s)' % (LOOPBACK, self.port, exc))
            try:
                listener.close()
            except OSError:
                pass
            return 1
        event('listen', '%s:%d child="%s"' % (LOOPBACK, self.port, ' '.join(child_argv())))
        note('listening on %s:%d' % (LOOPBACK, self.port))
        # THE WATCHDOG FIRST, and only after bind: it is what turns a wedged
        # call into a coded error, and `wedge_deadline_ms() == 0` is the
        # documented kill switch that never starts it at all.
        self.start_wedge_watch()
        # ONE background self-check, and only AFTER the listener exists: a
        # measurement in front of accept() would be an outage, and the listener
        # is what makes a client wait. Daemon, never joined, and wrapped, so a
        # raise inside it cannot take the listener down with it.
        facts_thread = threading.Thread(target=self.publish_desktop_facts,
                                        name='desktop-facts')
        facts_thread.daemon = True
        facts_thread.start()
        self.facts_thread = facts_thread
        try:
            while True:
                try:
                    conn, _addr = listener.accept()
                except InterruptedError:
                    continue
                except OSError:
                    break
                # One thread per ACCEPTED connection, so probes are answered
                # even while a session holds the lock.
                worker = threading.Thread(target=self.handle, args=(conn,))
                worker.daemon = True
                worker.start()
        except KeyboardInterrupt:
            pass
        finally:
            # Tell both loops to finish BEFORE the listener state goes away: a
            # facts pass that wakes up into a closed listener must not log a
            # second "desktop-facts" line after listen-stopped.
            self.stop.set()
            try:
                listener.close()
            except OSError:
                pass
            self.stop_child()
            event('listen-stopped', 'port=%d' % self.port)
        return 0


# --------------------------------------------------------------------------- #
# --connect
# --------------------------------------------------------------------------- #
def stdin_reader(chunks, stop):
    """Blocking stdin reader for --connect: one daemon thread, no select().

    WHY A THREAD AND NOT select() (the previous shape): select() only accepts
    sockets on Windows, so the old pump had to call os.read(0) directly there.
    On a PIPE that read blocks with no timeout and is not interruptible by
    anything this process does: when the serve side (or its child) died, the
    socket pump set `closed`, but the MAIN thread was parked inside os.read(0)
    and never looked at it again - --connect hung instead of exiting on EOF.
    (msvcrt.kbhit/peek is not a substitute: it is console-only and answers
    nothing for a redirected stdin pipe, which is exactly what ssh hands us.)

    So the roles are inverted: THIS thread is allowed to block forever (it is a
    daemon, so process exit does not wait for it), and the main thread waits on
    a queue with a short timeout. A chunk is forwarded as-is; b'' is EOF and
    ends both sides. `stop` is only a hint for a reader that has not entered
    read() yet; the daemon flag covers the blocked case.
    """
    while not stop.is_set():
        data = read_fd(0)
        chunks.put(data)
        if not data:
            return


def run_connect(port):
    try:
        sock = socket.create_connection((LOOPBACK, port), timeout=10)
    except OSError as exc:
        event('connect-refused', '%s:%d %s' % (LOOPBACK, port, exc))
        note('cannot connect %s:%d (%s) - is the cua-mcp-host task running?' % (LOOPBACK, port, exc))
        return 1
    sock.settimeout(None)
    event('client-attach', '%s:%d' % (LOOPBACK, port))
    closed = threading.Event()

    def socket_to_stdout():
        while True:
            try:
                data = sock.recv(CHUNK)
            except InterruptedError:
                continue
            except OSError:
                data = b''
            if not data:
                break
            if not write_all(1, data):
                break
        closed.set()
        # Unblocks the stdin pump's next write instead of leaving it in a
        # failing send loop.
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    pump = threading.Thread(target=socket_to_stdout)
    pump.daemon = True
    pump.start()
    chunks = queue.Queue()
    stop = threading.Event()
    reader = threading.Thread(target=stdin_reader, args=(chunks, stop))
    reader.daemon = True
    reader.start()
    stdin_eof = False
    while not closed.is_set() and not stdin_eof:
        try:
            data = chunks.get(timeout=0.25)
        except queue.Empty:
            continue
        if not data:
            stdin_eof = True
            break
        try:
            sock.sendall(data)
        except OSError:
            break
    stop.set()
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    pump.join(2.0)
    close_socket(sock)
    event('client-detach', 'clean')
    return 0


# --------------------------------------------------------------------------- #
# --ping
# --------------------------------------------------------------------------- #
def read_probe_answer(sock, deadline):
    """Read EXACTLY len(PROBE_OK) bytes, or fail.

    A single recv() is not the answer: TCP may deliver the 8 bytes of
    RELAY_OK in pieces, so the reader accumulates until the count is reached.
    A short read, EOF before the count, or a deadline overrun is a failure -
    it must never be mistaken for a match, and it must never hang.
    """
    want = len(PROBE_OK)
    buffered = b''
    while len(buffered) < want:
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        try:
            sock.settimeout(PING_TIMEOUT if remaining > PING_TIMEOUT else remaining)
            chunk = sock.recv(want - len(buffered))
        except InterruptedError:
            continue
        except (socket.timeout, OSError):
            return None
        if not chunk:
            return None                      # EOF / short read
        buffered += chunk
    return buffered


def emit_token(token):
    """Exactly one token plus newline on stdout - and never a traceback.

    The caller parses this stream, so a broken pipe must not turn a clean
    RELAY_DOWN into a crash after the verdict is already known.
    """
    try:
        sys.stdout.write(token.decode('ascii') + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def run_ping(port):
    """Accept-loop liveness: RELAY_PING out, RELAY_OK in, one token on stdout.

    RELAY_OK means the relay's accept loop answered the RELAY_PING handshake
    inside 2 s. It is **not** a claim about the MCP child: the child is proven
    only by the functional probe (RELAY_FN, then a real initialize + tools/list
    round trip), whose answer is RELAY_OK with measured:true or
    RELAY_UNRESPONSIVE. A dead child is restarted on demand, so this token is
    evidence about the LANE, never a verdict about the tools.

    Nothing here touches the desktop, the child, or the session lock - the
    --serve side answers a probe before it looks at either - so this stays
    cheap enough to run on a timer over SSH. Every failure mode collapses to
    the same RELAY_DOWN/exit 1: connect refused, connect timed out, write
    failed, short read, EOF, or a reply that is not exactly RELAY_OK.
    """
    deadline = time.time() + PING_BUDGET
    sock = None
    ok = False
    reason = ''
    try:
        sock = socket.create_connection((LOOPBACK, port), timeout=PING_TIMEOUT)
        sock.sendall(PROBE_PING)
        answer = read_probe_answer(sock, deadline)
        if answer is None:
            reason = 'no answer (timeout/EOF/short read)'
        elif answer != PROBE_OK:
            reason = 'unexpected answer %r' % (answer,)
        else:
            ok = True
    except Exception as exc:                 # refused, DNS, bad port, anything
        reason = repr(exc)
    finally:
        if sock is not None:
            close_socket(sock)
    # Down is worth a log line (this is the signal the session-0 fallback keys
    # off); up is not, or a 30 s probe would flood the relay log.
    if not ok:
        event('ping-probe-down', 'port=%d %s' % (port, reason))
    emit_token(PROBE_OK if ok else PROBE_DOWN)
    return 0 if ok else 1


# --------------------------------------------------------------------------- #
def usage():
    note('usage: cua-mcp-relay.py --serve | --connect | --ping [port] [--port N]')


def env_port():
    raw = os.environ.get('DSH_CUA_MCP_RELAY_PORT', '').strip()
    if not raw:
        return DEFAULT_PORT
    try:
        value = int(raw)
    except ValueError:
        note('DSH_CUA_MCP_RELAY_PORT=%r is not a number; using %d' % (raw, DEFAULT_PORT))
        return DEFAULT_PORT
    if value < 1 or value > 65535:
        note('DSH_CUA_MCP_RELAY_PORT=%d is out of range; using %d' % (value, DEFAULT_PORT))
        return DEFAULT_PORT
    return value


def main(argv):
    mode = None
    port = None
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg == '--serve':
            mode = 'serve'
        elif arg == '--connect':
            mode = 'connect'
        elif arg == '--ping':
            mode = 'ping'
            # `--ping [port]`: the port is OPTIONAL and positional. Consume
            # the next argv only when it is a bare number, so `--ping --port N`
            # keeps working and `--ping` alone falls through to the env port.
            if index + 1 < len(argv) and argv[index + 1].isdigit():
                port = int(argv[index + 1])
                index += 1
        elif arg.startswith('--ping='):
            mode = 'ping'
            try:
                port = int(arg.split('=', 1)[1])
            except ValueError:
                usage()
                return 2
        elif arg == '--port':
            index += 1
            try:
                port = int(argv[index])
            except (IndexError, ValueError):
                usage()
                return 2
        elif arg.startswith('--port='):
            try:
                port = int(arg.split('=', 1)[1])
            except ValueError:
                usage()
                return 2
        else:
            usage()
            return 2
        index += 1
    if mode is None:
        usage()
        return 2
    if port is None:
        port = env_port()
    if mode == 'serve':
        return Relay(port).run()
    if mode == 'ping':
        return run_ping(port)
    return run_connect(port)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
