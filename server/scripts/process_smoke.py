"""Check the actual binary, WebSocket purchase and PostgreSQL persistence."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import subprocess
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def query(dsn, statement):
    parsed = urllib.parse.urlsplit(dsn)
    if parsed.path != "/hackaton_test":
        raise RuntimeError("TEST_DATABASE_URL must point to hackaton_test")
    options = dict(urllib.parse.parse_qsl(parsed.query))
    env = dict(os.environ, PGHOST=parsed.hostname or "", PGPORT=str(parsed.port or 5432),
               PGUSER=urllib.parse.unquote(parsed.username or ""),
               PGPASSWORD=urllib.parse.unquote(parsed.password or ""), PGDATABASE="hackaton_test",
               PGCONNECT_TIMEOUT="3", PGSSLMODE=options.get("sslmode", "prefer"))
    if "search_path" in options:
        if not re.fullmatch(r"test_smoke_[0-9a-f]+", options["search_path"]):
            raise RuntimeError("unsafe smoke-test schema")
        env["PGOPTIONS"] = "-c search_path=" + options["search_path"]
    result = subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t"],
                            input=statement, env=env, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError("PostgreSQL smoke query failed: " + result.stderr)
    return result.stdout.strip()

def scoped(dsn, name):
    parsed = urllib.parse.urlsplit(dsn)
    options = dict(urllib.parse.parse_qsl(parsed.query))
    options["search_path"] = name
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(options)))

def request(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status, json.load(response)

class WS:
    """Small RFC6455 client for this smoke test; no Python packages required."""
    def __init__(self, base, token):
        address = urllib.parse.urlsplit(base)
        self.socket = socket.create_connection((address.hostname, address.port), timeout=5)
        self.socket.settimeout(5)
        self.file = self.socket.makefile("rb")
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        path = "/ws?" + urllib.parse.urlencode({"token": token})
        headers = (f"GET {path} HTTP/1.1\r\nHost: {address.netloc}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.socket.sendall(headers.encode())
        if b" 101 " not in self.file.readline():
            raise RuntimeError("WebSocket upgrade failed")
        response = {}
        while True:
            line = self.file.readline()
            if line == b"\r\n":
                break
            if not line:
                raise RuntimeError("WebSocket handshake ended")
            name, value = line.decode().split(":", 1)
            response[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if response.get("sec-websocket-accept") != expected:
            raise RuntimeError("invalid WebSocket handshake")

    def frame(self, opcode, payload):
        size = len(payload)
        header = bytes([0x80 | opcode])
        header += bytes([0x80 | size]) if size < 126 else bytes([0xfe]) + struct.pack("!H", size)
        mask = secrets.token_bytes(4)
        self.socket.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload)))

    def send(self, kind, payload):
        self.frame(1, json.dumps({"type": kind, "payload": payload}).encode())

    def until(self, kind):
        while True:
            head = self.file.read(2)
            if len(head) != 2:
                raise RuntimeError("WebSocket closed")
            opcode, size = head[0] & 15, head[1] & 127
            if size == 126:
                size = struct.unpack("!H", self.file.read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.file.read(8))[0]
            if size > 1024 * 1024:
                raise RuntimeError("unexpected oversized server frame")
            payload = self.file.read(size)
            if len(payload) != size:
                raise RuntimeError("incomplete WebSocket frame")
            if opcode == 9:
                self.frame(10, payload)
                continue
            if opcode == 8:
                raise RuntimeError("server closed WebSocket")
            if opcode != 1:
                continue
            packet = json.loads(payload)
            if packet["type"] == "ERROR":
                raise RuntimeError("game error: " + packet["payload"]["code"])
            if packet["type"] == kind:
                return packet["payload"]

    def close(self):
        self.file.close()
        self.socket.close()

def launch(env):
    proc = subprocess.Popen([str(ROOT / "bin/server")], cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = proc.stderr.readline()
    match = re.search(r"server listening on (127[.]0[.]0[.]1:[0-9]+)", line)
    if not match:
        proc.terminate()
        _, rest = proc.communicate(timeout=10)
        raise RuntimeError(f"server did not start: {line}{rest}")
    return proc, "http://" + match.group(1)

def stop(proc):
    proc.terminate()
    try:
        _, errors = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise
    if proc.returncode != 0:
        raise RuntimeError(f"unclean shutdown {proc.returncode}: {errors}")

def expect_start_failure(env, expected):
    result = subprocess.run([str(ROOT / "bin/server")], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=12)
    assert result.returncode != 0
    assert "server listening on" not in result.stderr
    assert expected in result.stderr, result.stderr

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--restart-db", action="store_true",
                        help="restart only this project's Compose db between two server starts")
    args = parser.parse_args()
    dsn = os.environ.get("TEST_DATABASE_URL", "")
    schemas = ["test_smoke_" + secrets.token_hex(8) for _ in range(2)]
    for name in schemas:
        query(dsn, f'CREATE SCHEMA "{name}"')
    active, conflict = (scoped(dsn, name) for name in schemas)
    try:
        env = dict(os.environ, JWT_SECRET=secrets.token_hex(32), SERVER_ADDR="127.0.0.1:0",
                   DATABASE_URL=active, AI_URL="http://127.0.0.1:1")
        expect_start_failure(dict(env, JWT_SECRET=""), "JWT_SECRET")
        expect_start_failure(dict(env, DATABASE_URL=""), "DATABASE_URL")
        expect_start_failure(dict(env, DATABASE_URL="postgres://hackaton@127.0.0.1:1/hackaton_test?sslmode=disable"),
                             "PostgreSQL connection failed")
        expect_start_failure(dict(env, WORLD_DIR="/nonexistent-role-a-smoke-world"), "no such file")
        query(conflict, "CREATE TABLE known_words(legacy_value TEXT)")
        expect_start_failure(dict(env, DATABASE_URL=conflict), "migration 1")
        assert query(conflict, "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('players','schema_migrations')") == "0"
        proc, base = launch(env)
        ws = None
        try:
            assert request(base, "/health")[1]["db"] == "ok"
            status, created = request(base, "/auth/register",
                {"login": "smoke_user", "password": "smoke_password123", "profile": "culture"})
            assert status == 201 and "password_hash" not in created["player"]
            ws = WS(base, created["token"])
            ws.until("WELCOME")
            ws.until("WORLD_STATS")
            ws.send("MOVE", {"x": 111, "z": 112, "rotation": 0.5})
            ws.send("DIALOGUE", {"npc_id": "lao_wang"})
            ws.until("NPC_SPEECH")
            ws.send("TRADE_START", {"npc_id": "lao_wang", "item_id": "jade_amulet"})
            proposal = ws.until("TRADE_OPEN")
            confirmation = {"npc_id": "lao_wang", "item_id": "jade_amulet",
                            "trade_id": proposal["trade_id"], "amount": 150}
            ws.send("CALCULATOR", confirmation)
            result = ws.until("TRADE_RESULT")
            assert result["status"] == "purchased" and not result["replayed"]
            assert ws.until("BALANCE")["balance"] == 350
        finally:
            if ws:
                ws.close()
            stop(proc)
        if args.restart_db:
            for command in (["docker", "compose", "restart", "db"],
                            ["docker", "compose", "up", "-d", "--wait", "db"]):
                subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True, timeout=90)
        proc, base = launch(env)
        ws = None
        try:
            _, saved = request(base, "/auth/login",
                {"login": "smoke_user", "password": "smoke_password123"})
            expected = dict(created["player"], x=111, z=112, rotation=0.5, balance=350)
            assert saved["player"] == expected
            assert saved["known_words"] == created["known_words"]
            assert saved["inventory"] == [{"item_id": "jade_amulet", "price_paid": 150}]
            ws = WS(base, saved["token"])
            ws.until("WELCOME")
            ws.until("WORLD_STATS")
            ws.send("CALCULATOR", confirmation)
            replay = ws.until("TRADE_RESULT")
            assert replay["replayed"] and replay["receipt"] == result["receipt"]
            balance = ws.until("BALANCE")
            assert balance["balance"] == 350 and balance["delta"] == 0
            assert query(active, "SELECT current_price||':'||version FROM npc_scenes WHERE npc_id='lao_wang'") == "150:2"
        finally:
            if ws:
                ws.close()
            stop(proc)
    finally:
        for name in schemas:
            query(dsn, f'DROP SCHEMA "{name}" CASCADE')
    print("PASS: PostgreSQL startup failures, WS purchase, SIGTERM, restart, persisted profile/scene/receipt"
          + (" and project DB container restart" if args.restart_db else ""))

if __name__ == "__main__":
    main()
