#!/usr/bin/env python3
# -*- coding: ascii -*-
"""fake-wedged-child.py - a stand-in MCP child for tests/relay-wedge.mjs.

WHY IT EXISTS: the two behaviours WP-A has to prove are things a REAL MCP
server only does when the desktop wedges it - answer nothing, forever, while
staying alive and readable - and "answer normally" (so the lane can be shown to
heal). A fixture makes both deterministic and makes the relay's byte bridge
observable, which is the only way to assert that accounting changed no byte.

HOW IT IS DRIVEN (all optional, via the environment):

  FAKE_CHILD_WEDGE_MARKER  path to a file holding an integer N. At start a child
                           that finds N > 0 writes N-1 back and then WEDGES for
                           its whole life: it reads every byte, logs it, and
                           answers nothing. N == 0 (or no file) behaves normally.
                           That is how "the first child wedges, the replacement
                           answers" is expressed without timing tricks.
  FAKE_CHILD_RX_LOG        path to a file that receives EVERY byte this child
                           read from stdin, appended verbatim, so the caller can
                           compare an exact payload byte for byte.
  FAKE_CHILD_READY         path to a file that receives one line per start
                           (`<pid> wedged|live`), for a caller that wants to see
                           which children actually ran.
  FAKE_CHILD_BIG_RESULT    pad characters to put in every `result` (an integer).
                           A real server answers capture_window/get_text with
                           multi-megabyte payloads on ONE line, which is what
                           makes the relay's 1 MiB scan cap observable: the
                           result must cross the bridge byte-exactly and the
                           relay must not mistake its own dropped bookkeeping
                           for a wedged child.
  FAKE_CHILD_CRASH_MARKER  path to a file holding an integer N. A child that
                           finds N > 0 writes N-1 back and then CRASHES on the
                           first line it receives: it exits WITHOUT answering,
                           and it leaves a short-lived grandchild holding its
                           stdout pipe so the relay's reader does NOT see EOF
                           and run its own cleanup. That is the exact state the
                           respawn bookkeeping has to survive - a dead child
                           whose request id is still outstanding while a fresh
                           child takes over - and it cannot be produced by a
                           clean exit, which the reader notices first.
  FAKE_CHILD_HOLD_PIPE_SECONDS
                           how long the crash grandchild keeps the pipe open
                           (default 3 s; must be well past the test's wedge
                           deadline, so the respawn happens first).

ANSWERS (normal mode) are newline-delimited JSON-RPC 2.0 objects:
  initialize  -> a protocolVersion/capabilities/serverInfo result
  tools/list  -> one tool
  anything else with an id -> {"result": {"ok": true}}
A notification (no id) is never answered, and a non-JSON line is never answered
either - it is logged and dropped, exactly like a server that cannot parse it.
"""

import json
import os
import sys

WEDGE_MARKER = os.environ.get('FAKE_CHILD_WEDGE_MARKER', '')
RX_LOG = os.environ.get('FAKE_CHILD_RX_LOG', '')
READY = os.environ.get('FAKE_CHILD_READY', '')
BIG_RESULT = os.environ.get('FAKE_CHILD_BIG_RESULT', '')
CRASH_MARKER = os.environ.get('FAKE_CHILD_CRASH_MARKER', '')
HOLD_PIPE_SECONDS = os.environ.get('FAKE_CHILD_HOLD_PIPE_SECONDS', '3')


def append_bytes(path, data):
    if not path:
        return
    try:
        handle = open(path, 'ab')
        try:
            handle.write(data)
            handle.flush()
        finally:
            handle.close()
    except Exception:
        pass


def append_line(path, text):
    if not path:
        return
    try:
        handle = open(path, 'a')
        try:
            handle.write(text + '\n')
            handle.flush()
        finally:
            handle.close()
    except Exception:
        pass


def take_ticket(path):
    """Consume one ticket from a marker file; True when this child has one.

    The ticket is consumed at start, before the first read, so the caller only
    has to write the number of children that should misbehave - no ordering
    assumption about which spawn happens first.
    """
    if not path:
        return False
    try:
        handle = open(path, 'r+')
    except Exception:
        return False
    try:
        text = (handle.read() or '').strip()
        try:
            tickets = int(text) if text else 0
        except ValueError:
            tickets = 0
        if tickets <= 0:
            return False
        handle.seek(0)
        handle.truncate()
        handle.write(str(tickets - 1))
        handle.flush()
        return True
    finally:
        handle.close()


def take_wedge_ticket():
    """True when THIS child must wedge instead of answering."""
    return take_ticket(WEDGE_MARKER)


def hold_pipe_then_die():
    """Exit WITHOUT answering, leaving stdout open from a grandchild.

    A clean exit closes the pipe, so the relay's reader sees EOF immediately and
    runs its own cleanup (which already forgets the ids). Holding the pipe keeps
    the reader parked in read() while the pump notices the death and respawns -
    the only way to reach the respawn-with-pending state from outside.
    """
    try:
        seconds = float(HOLD_PIPE_SECONDS)
    except ValueError:
        seconds = 3.0
    if seconds < 0:
        seconds = 0.0
    try:
        import subprocess
        subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(%r)' % (seconds,)],
            stdin=subprocess.DEVNULL,
            stdout=sys.stdout,          # inherits the pipe: no EOF for the relay
            stderr=subprocess.DEVNULL,
            close_fds=False,
        )
    except Exception:
        pass
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(1)


def big_pad_chars():
    """How many pad characters to put in a result, or 0 for a normal answer."""
    text = (BIG_RESULT or '').strip()
    if not text:
        return 0
    try:
        value = int(text)
    except ValueError:
        return 0
    return value if value > 0 else 0


def send(payload):
    data = json.dumps(payload, ensure_ascii=True) + '\n'
    try:
        sys.stdout.write(data)
        sys.stdout.flush()
    except Exception:
        pass


def handle_line(line, wedged):
    if wedged:
        return                          # THE WEDGE: read, log, never answer.
    if not line.strip():
        return
    try:
        message = json.loads(line.decode('utf-8', 'replace'))
    except Exception:
        return                          # not JSON-RPC: nothing to answer
    if not isinstance(message, dict):
        return
    method = message.get('method')
    if not isinstance(method, str):
        return
    call_id = message.get('id')
    if call_id is None:
        return                          # a notification is never answered
    if method == 'initialize':
        send({'jsonrpc': '2.0', 'id': call_id,
              'result': {'protocolVersion': '2025-06-18',
                         'capabilities': {'tools': {}},
                         'serverInfo': {'name': 'fake-wedged-child',
                                        'version': '1.0.0'}}})
        return
    if method == 'tools/list':
        send({'jsonrpc': '2.0', 'id': call_id,
              'result': {'tools': [{'name': 'fake_tool',
                                    'description': 'a fixture tool',
                                    'inputSchema': {'type': 'object'}}]}})
        return
    pad = big_pad_chars()
    if pad > 0:
        # ONE line, past any sane scan cap: the point of the fixture's big mode.
        send({'jsonrpc': '2.0', 'id': call_id,
              'result': {'ok': True, 'pad': 'x' * pad}})
        return
    send({'jsonrpc': '2.0', 'id': call_id, 'result': {'ok': True}})


def main():
    wedged = take_wedge_ticket()
    crashes = take_ticket(CRASH_MARKER)
    append_line(READY, '%d %s%s' % (os.getpid(),
                                    'wedged' if wedged else 'live',
                                    ' crash-on-first-line' if crashes else ''))
    buffer = b''
    while True:
        # os.read, not stdin.read: read(n) on a pipe blocks for n bytes or EOF,
        # which would hold every short request forever.
        try:
            chunk = os.read(0, 4096)
        except InterruptedError:
            continue
        except OSError:
            return 0
        if not chunk:
            return 0
        append_bytes(RX_LOG, chunk)
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            if crashes:
                # THE CRASH: the request was read (and logged) and is never
                # answered, exactly like a server killed inside a tool call.
                hold_pipe_then_die()
            handle_line(line, wedged)


if __name__ == '__main__':
    sys.exit(main())
