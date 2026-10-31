"""Exercise the built server as a real process, including SIGTERM and restart."""
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def request(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status, json.load(response)

def launch(env):
    proc = subprocess.Popen(
        [str(ROOT / "bin/server")], cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
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
                            capture_output=True, text=True, timeout=10)
    assert result.returncode != 0, "invalid startup unexpectedly succeeded"
    assert "server listening on" not in result.stderr, "port opened before validation"
    assert expected in result.stderr, result.stderr

def main():
    with tempfile.TemporaryDirectory(prefix="role-a-smoke-") as tmp:
        env = dict(os.environ, JWT_SECRET=secrets.token_hex(32),
                   SERVER_ADDR="127.0.0.1:0", DB_PATH=str(Path(tmp) / "game.db"))
        expect_start_failure(dict(env, JWT_SECRET=""), "JWT_SECRET")
        expect_start_failure(dict(env, WORLD_DIR=str(Path(tmp) / "absent")), "no such file")
        conflict = str(Path(tmp) / "conflicting.db")
        with sqlite3.connect(conflict) as database:
            database.execute("CREATE TABLE known_words(legacy_value TEXT)")
        expect_start_failure(dict(env, DB_PATH=conflict), "migration 1")
        proc, base = launch(env)
        try:
            status, health = request(base, "/health")
            assert status == 200 and health["db"] == "ok"
            status, created = request(base, "/auth/register",
                {"login": "smoke_user", "password": "smoke_password123", "profile": "culture"})
            assert status == 201 and created["player"]["balance"] == 500
            assert "password_hash" not in created["player"]
        finally:
            stop(proc)
        proc, base = launch(env)
        try:
            status, saved = request(base, "/auth/login",
                {"login": "smoke_user", "password": "smoke_password123"})
            assert status == 200
            assert saved["player"] == created["player"]
            assert saved["known_words"] == created["known_words"]
            assert saved["inventory"] == []
        finally:
            stop(proc)
    print("PASS: invalid config/migration fail before listen; startup, health, registration, SIGTERM, restart and persisted login")

if __name__ == "__main__":
    main()
