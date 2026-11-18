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

MODES
-----
  python cua-mcp-relay.py --serve     listen 127.0.0.1:<port>, one client at a
                                      time, child kept/restarted as needed
  python cua-mcp-relay.py --connect   bridge stdin/stdout <-> 127.0.0.1:<port>

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

Stdlib only, ASCII only, and the pump is written so the whole file can be
exercised on Linux (`DSH_CUA_MCP_SERVER=cat` is a byte-exact echo server).
"""

import errno
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
# How long a fresh connection may take to prove itself a probe or a session.
# An MCP client sends `initialize` immediately, so this only bounds the cost of
# a connection that says nothing at all.
PROBE_WINDOW = 2.0
DEFAULT_PORT = 47999
LOOPBACK = '127.0.0.1'
DEFAULT_SERVER = 'python -m dsh_cua.server --stdio'
CHUNK = 65536
# Windows: never give the child a console. The relay itself is started by an
# interactive task (pythonw.exe, no console); a plain python.exe child would
# allocate one and leave the blank window on the user's desktop that the
# windowless-autostart fix exists to prevent.
CREATE_NO_WINDOW = 0x08000000

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
def usage():
    note('usage: cua-mcp-relay.py --serve | --connect [--port N]')


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
    return run_connect(port)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
