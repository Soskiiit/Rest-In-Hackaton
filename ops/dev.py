"""Run the integrated stack in WSL; Ctrl+C stops only its child processes."""
import argparse
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def environment():
    env = dict(os.environ)
    path = ROOT / 'server/.env'
    if not path.exists():
        subprocess.run(['python3', 'scripts/setup_env.py'], cwd=ROOT / 'server', check=True)
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        parts = shlex.split(value)
        env.setdefault(key.strip(), parts[0] if parts else '')
    env['PATH'] = '/usr/local/go/bin:' + env.get('PATH', '')
    return env

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mock', action='store_true', help='Never contact an inference server')
    parser.add_argument('--test-db', action='store_true', help='Use and clean an isolated hackaton_test schema')
    args = parser.parse_args()
    env = environment()
    if args.mock:
        env['MOCK_MODE'] = '1'
    env.setdefault('AI_URL', 'http://127.0.0.1:8000')
    # The explicit list in .env remains authoritative for LAN origins.
    logs = ROOT / '.integration'
    logs.mkdir(exist_ok=True)
    children, streams = [], []
    schema = None
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        subprocess.run(['docker', 'compose', 'up', '-d', '--wait', 'db'], cwd=ROOT / 'server', env=env, check=True)
        if args.test_db:
            sys.path.insert(0, str(ROOT / 'server/scripts'))
            from process_smoke import query, scoped
            schema = 'test_smoke_' + secrets.token_hex(8)
            query(env['TEST_DATABASE_URL'], 'CREATE SCHEMA ' + schema)
            env['DATABASE_URL'] = scoped(env['TEST_DATABASE_URL'], schema)
        subprocess.run(['go', 'build', '-o', 'bin/server', './cmd/server'], cwd=ROOT / 'server', env=env, check=True)
        services = [
            ('ai', [str(ROOT / 'ai/.venv/bin/python'), '-m', 'uvicorn', 'ai.middleware:app', '--host', '127.0.0.1', '--port', '8000'], ROOT),
            ('server', [str(ROOT / 'server/bin/server')], ROOT / 'server'),
            ('client', ['npm', 'run', 'dev'], ROOT / 'client'),
        ]
        for name, command, cwd in services:
            stream = (logs / (name + '.log')).open('w')
            streams.append(stream)
            children.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT))
        for url in ['http://127.0.0.1:8000/health', 'http://127.0.0.1:3000/health', 'http://127.0.0.1:5173']:
            for _ in range(100):
                if any(p.poll() is not None for p in children):
                    raise RuntimeError('A service exited; see .integration/*.log')
                try:
                    with urllib.request.urlopen(url, timeout=1) as response:
                        if response.status == 200: break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError('Service not ready: ' + url)
        print('READY: http://localhost:5173 | Go :3000 | AI :8000 | mock=' + str(args.mock), flush=True)
        while all(p.poll() is None for p in children):
            time.sleep(0.5)
        raise RuntimeError('A service stopped; see .integration/*.log')
    except KeyboardInterrupt:
        pass
    finally:
        for process in reversed(children):
            if process.poll() is None: process.terminate()
        for process in reversed(children):
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for stream in streams: stream.close()
        if schema:
            query(env['TEST_DATABASE_URL'], 'DROP SCHEMA ' + schema + ' CASCADE')

if __name__ == '__main__':
    main()
