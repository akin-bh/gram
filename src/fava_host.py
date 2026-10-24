"""gram's Fava host: one read-only Fava app per company, on a Unix socket only gram reaches.

gram writes each company's books to <ledgers>/<world-id>.beancount and proxies
/fava/<world-id>/... to this process behind its controller session. Fava itself has no
login, so it listens on no TCP port. The process exits when gram closes its stdin.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import threading
from pathlib import Path

from cheroot.wsgi import Server
from fava.application import create_app

WORLD = re.compile(r"^/fava/(world-[A-Za-z0-9-]{1,200})(/.*)?$")


def respond(start_response, status: str, body: bytes):
    start_response(status, [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))])
    return [body]


class Companies:
    """Dispatch /fava/<world-id>/ to that company's Fava app, created on first use."""

    def __init__(self, ledgers: Path, trusted_hosts: list[str]) -> None:
        self.ledgers = ledgers
        self.trusted_hosts = trusted_hosts
        self.apps: dict[str, object] = {}
        self.lock = threading.Lock()

    def app(self, world: str, ledger: Path):
        with self.lock:
            if world not in self.apps:
                # The poll watcher compares mtimes on each request, which survives gram's atomic renames.
                app = create_app([str(ledger)], read_only=True, poll_watcher=True)
                app.config["TRUSTED_HOSTS"] = self.trusted_hosts
                self.apps[world] = app
            return self.apps[world]

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path == "/healthz":
            return respond(start_response, "200 OK", b"ok")
        match = WORLD.match(path)
        if not match:
            return respond(start_response, "404 Not Found", b"no such company")
        world, rest = match.group(1), match.group(2) or "/"
        ledger = self.ledgers / f"{world}.beancount"
        if not ledger.is_file():
            return respond(start_response, "404 Not Found", b"no books for this company yet")
        environ["SCRIPT_NAME"] = environ.get("SCRIPT_NAME", "") + f"/fava/{world}"
        environ["PATH_INFO"] = rest
        return self.app(world, ledger)(environ, start_response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--ledgers", required=True, type=Path)
    parser.add_argument("--trusted-host", action="append", default=[])
    args = parser.parse_args()

    args.socket.unlink(missing_ok=True)
    server = Server(str(args.socket), Companies(args.ledgers, args.trusted_host), numthreads=8)
    server.prepare()
    os.chmod(args.socket, 0o600)
    print("fava-host ready", flush=True)

    def stop_with_parent() -> None:
        sys.stdin.read()
        server.stop()

    threading.Thread(target=stop_with_parent, daemon=True).start()
    try:
        server.serve()
    finally:
        args.socket.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
