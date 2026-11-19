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
b'RELAY_OK' and closed, before any child is spawned or touched. A real MCP
client sends `{"jsonrpc":...` first, so the two are unambiguous. The probe is
handled OUTSIDE the single-session lock, so a health check cannot be blocked by
(or block) a live MCP session.

DESKTOP FACTS: THE ONE THING MEASURED, NOT BRIDGED
---------------------------------------------------
Every claim this repo makes about the desktop used to be an assumption formed on
the host. The listener mode is the only process that holds the desktop token, so
it is the only one that can answer: does `win32ui` import, does the pywinauto UIA
wrapper import, does the installed `dsh_cua.bridge` carry the corrected scale
arithmetic, and can THIS token write `C:\\cua-work` - and its own profile root
(the measured contrast, never a "fix")? It answers once, in a daemon thread
started AFTER the listener binds (never in front of accept), bounded at 20 s, and
writes one JSON object to `C:\\cua-work\\cua-desktop-facts.json`, falling back to
`%TEMP%` when the work directory is not writable. A failure writes the same file
with `measured:false` and the reason. No pump, no file descriptor and no argument
changes: `--ping` still answers while it runs, and no byte of the MCP stream is
touched.

MODES
-----
  python cua-mcp-relay.py --serve     listen 127.0.0.1:<port>, one client at a
                                      time, child kept/restarted as needed
  python cua-mcp-relay.py --connect   bridge stdin/stdout <-> 127.0.0.1:<port>
  python cua-mcp-relay.py --ping [port]
                                      liveness probe: send RELAY_PING, read the
                                      8-byte answer, print exactly RELAY_OK or
                                      RELAY_DOWN. Bounded to ~2 s wall, no child,
                                      no lock, no desktop access.

ENVIRONMENT
-----------
  DSH_CUA_MCP_RELAY_PORT   listen/connect port, default 47999
  DSH_CUA_MCP_SERVER       child command line override
                           (default: "python -m dsh_cua.server --stdio")
  DSH_CUA_MCP_RELAY_LOG    log path override (default on Windows:
                           C:\\ProgramData\\cua\\mcp-relay.log)

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

# The probe pair. Fixed bytes, compared with ==, never stripped or decoded.
PROBE_PING = b'RELAY_PING'
PROBE_OK = b'RELAY_OK'
PROBE_DOWN = b'RELAY_DOWN'
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
        try:
            handle = open(path, 'w')
            try:
                handle.write(payload + '\n')
            finally:
                handle.close()
        except Exception:
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


def publish_desktop_facts():
    """Measure once, write once, log once. Never raises, never blocks a pump.

    Runs in its own daemon thread, started AFTER the listener binds, so the
    bridge is already accepting sessions while this measures. Local to the
    guest, bounded by FACTS_PROBE_TIMEOUT, sharing no state with the pumps.
    """
    started = time.time()
    try:
        facts = collect_desktop_facts()
    except Exception as exc:
        facts = empty_facts()
        facts['error'] = 'collect: %s' % (short_error(exc),)
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
          'elapsed=%.2fs path="%s" error="%s"' % (
              'true' if facts.get('measured') else 'false',
              source or 'none',
              'true' if facts.get('win32ui') else 'false',
              'true' if facts.get('uiaLane') else 'false',
              facts.get('scaleFix') or '',
              'true' if facts.get('workDirWritable') else 'false',
              'true' if facts.get('profileRootWritable') else 'false',
              elapsed,
              path,
              (facts.get('error') or '')[:200],
          ))
    return facts


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

    # -- child lifecycle ---------------------------------------------------- #
    def child(self):
        """The live child, spawning a replacement if it died."""
        with self.proc_lock:
            proc = self.proc
            if proc is not None and proc.poll() is None:
                return proc
            if proc is not None:
                event('child-exit', 'pid=%d code=%s' % (proc.pid, proc.returncode))
                self.proc = None
            argv = child_argv()
            proc = spawn_child(argv)
            if proc is None:
                return None
            self.proc = proc
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
            try:
                client.sendall(data)
            except OSError:
                close_socket(client)
                with self.proc_lock:
                    if self.client is client:
                        self.client = None
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
                # A client waiting on a dead child must see EOF, not a hang.
                client = self.client
                self.client = None
            else:
                client = None
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
        """Thread target for the ONE background self-check.

        Deliberately thin: the module-level publish_desktop_facts() does the
        measuring and the logging, and this wrapper exists so that a raise
        inside it lands in the event log instead of killing the thread with a
        traceback nobody can read (pythonw.exe has no stderr).
        """
        try:
            publish_desktop_facts()
        except Exception as exc:
            event('desktop-facts-failed', repr(exc))

    # -- classification ----------------------------------------------------- #
    def classify(self, conn):
        """('probe', None) | ('session', preamble) | ('drop', None).

        Reading is PREFIX-AWARE: bytes are accumulated only while they could
        still be the probe. The moment they diverge, they are the session's own
        first request and are handed back untouched - nothing is consumed from
        a real client.
        """
        buffered = b''
        deadline = time.time() + PROBE_WINDOW
        while True:
            if buffered:
                if not PROBE_PING.startswith(buffered):
                    return ('session', buffered)     # diverged: a real session
                if buffered == PROBE_PING:
                    try:
                        conn.sendall(PROBE_OK)
                    except OSError:
                        pass
                    event('ping', 'answered RELAY_OK')
                    return ('probe', None)
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
            if len(buffered) > len(PROBE_PING):
                return ('session', buffered)        # cannot be the probe any more

    # -- one session -------------------------------------------------------- #
    def serve_client(self, conn, preamble):
        proc = self.child()
        if proc is None:
            event('connect-failed', 'no MCP server child')
            return
        with self.proc_lock:
            self.client = conn
        event('connect', 'client -> child pid=%d' % proc.pid)
        if preamble:
            if not write_all(proc.stdin.fileno(), preamble):
                event('write-failed', 'preamble')
                with self.proc_lock:
                    self.client = None
                return
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
            if not write_all(proc.stdin.fileno(), data):
                break
        with self.proc_lock:
            if self.client is conn:
                self.client = None
        state = 'kept' if proc.poll() is None else 'died; the next client restarts it'
        event('disconnect', 'client detached (child pid=%d %s)' % (proc.pid, state))

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
        # ONE background self-check, and only AFTER the listener exists: a
        # measurement in front of accept() would be an outage, and the listener
        # is what makes a client wait. Daemon, never joined, and wrapped, so a
        # raise inside it cannot take the listener down with it.
        facts_thread = threading.Thread(target=self.publish_desktop_facts,
                                        name='desktop-facts')
        facts_thread.daemon = True
        facts_thread.start()
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
    """Liveness probe: RELAY_PING out, RELAY_OK in, one token on stdout.

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
