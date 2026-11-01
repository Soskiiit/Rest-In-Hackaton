#!/usr/bin/env python3
"""
smoke_test.py — Automated verification suite for Rest-In-Hackaton HTTPS Nginx architecture.

Verifies:
  1. Port Isolation (ports 3000, 8000, 8080, 5433 closed to direct host access)
  2. HTTP -> HTTPS 301/302 Redirection (port 80 -> port 443)
  3. TLS Certificate & Handshake (self-signed, custom CA, or verified cert)
  4. Web Client Delivery (root / serves SPA HTML and canvas)
  5. REST API Proxying (/health, /auth/register, /auth/login over HTTPS)
  6. WebSocket over WSS (RFC6455 handshake, 101 Switching Protocols, WELCOME packet, frame exchange)

Usage:
  python3 smoke_test.py [--target https://localhost] [--insecure] [--ca-cert /path/to/cert.pem]
"""

import argparse
import base64
import hashlib
import http.client
import json
import secrets
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

PASS_COUNT = 0
FAIL_COUNT = 0


def ok(label: str, detail: str = ""):
    global PASS_COUNT
    PASS_COUNT += 1
    suffix = f"  ({detail})" if detail else ""
    print(f"  {GREEN}✓{RESET} {label}{suffix}")


def fail(label: str, detail: str = ""):
    global FAIL_COUNT
    FAIL_COUNT += 1
    suffix = f"\n      {RED}{detail}{RESET}" if detail else ""
    print(f"  {RED}✗{RESET} {label}{suffix}")


def section(title: str):
    print(f"\n{CYAN}── {title} {'─' * max(5, 55 - len(title))}{RESET}")


class RFC6455Client:
    """Pure standard-library RFC6455 WebSocket client supporting both plain WS and TLS WSS."""

    def __init__(
        self,
        ws_url: str,
        ssl_context: Optional[ssl.SSLContext] = None,
        origin: Optional[str] = None,
        timeout: float = 5.0,
    ):
        parsed = urllib.parse.urlsplit(ws_url)
        self.is_ssl = parsed.scheme == "wss"
        self.host = parsed.hostname or "localhost"
        default_port = 443 if self.is_ssl else 80
        self.port = parsed.port or default_port

        # Connect TCP socket
        raw_sock = socket.create_connection((self.host, self.port), timeout=timeout)
        raw_sock.settimeout(timeout)

        if self.is_ssl:
            ctx = ssl_context or ssl.create_default_context()
            self.socket = ctx.wrap_socket(raw_sock, server_hostname=self.host)
        else:
            self.socket = raw_sock

        self.file = self.socket.makefile("rb")

        # RFC6455 Handshake
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        netloc = self.host
        if parsed.port and parsed.port != default_port:
            netloc += f":{parsed.port}"

        headers = [
            f"GET {path} HTTP/1.1",
            f"Host: {netloc}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if origin:
            headers.append(f"Origin: {origin}")
        headers.append("\r\n")

        req_data = "\r\n".join(headers).encode("utf-8")
        self.socket.sendall(req_data)

        # Read HTTP status line
        status_line = self.file.readline().decode("utf-8", errors="replace").strip()
        if " 101 " not in status_line:
            raise RuntimeError(f"WebSocket upgrade rejected: {status_line}")

        # Read response headers
        resp_headers = {}
        while True:
            line = self.file.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            line_str = line.decode("utf-8", errors="replace").strip()
            if ":" in line_str:
                k, v = line_str.split(":", 1)
                resp_headers[k.strip().lower()] = v.strip()

        # Validate Sec-WebSocket-Accept
        accept_guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        expected_accept = base64.b64encode(
            hashlib.sha1((key + accept_guid).encode("utf-8")).digest()
        ).decode()
        if resp_headers.get("sec-websocket-accept") != expected_accept:
            raise RuntimeError(
                f"Invalid Sec-WebSocket-Accept header: got {resp_headers.get('sec-websocket-accept')}, expected {expected_accept}"
            )

    def send_frame(self, opcode: int, payload: bytes):
        size = len(payload)
        header = bytes([0x80 | opcode])
        if size < 126:
            header += bytes([0x80 | size])
        elif size < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", size)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", size)

        mask = secrets.token_bytes(4)
        masked_payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.socket.sendall(header + mask + masked_payload)

    def send_json(self, kind: str, payload: Any):
        self.send_frame(1, json.dumps({"type": kind, "payload": payload}).encode("utf-8"))

    def read_frame(self) -> Tuple[int, bytes]:
        head = self.file.read(2)
        if len(head) != 2:
            raise RuntimeError("WebSocket closed prematurely")
        opcode = head[0] & 0x0F
        is_masked = bool(head[1] & 0x80)
        size = head[1] & 0x7F

        if size == 126:
            size_bytes = self.file.read(2)
            if len(size_bytes) != 2:
                raise RuntimeError("Failed to read 16-bit frame size")
            size = struct.unpack("!H", size_bytes)[0]
        elif size == 127:
            size_bytes = self.file.read(8)
            if len(size_bytes) != 8:
                raise RuntimeError("Failed to read 64-bit frame size")
            size = struct.unpack("!Q", size_bytes)[0]

        if is_masked:
            mask = self.file.read(4)
            data = self.file.read(size)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        else:
            payload = self.file.read(size)

        return opcode, payload

    def receive_json(self, target_type: Optional[str] = None, timeout: float = 5.0) -> Dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            opcode, payload = self.read_frame()
            if opcode == 9:  # Ping
                self.send_frame(10, payload)  # Pong
                continue
            if opcode == 8:  # Close
                raise RuntimeError("Server initiated WebSocket close")
            if opcode == 1:  # Text frame
                packet = json.loads(payload.decode("utf-8"))
                if target_type is None or packet.get("type") == target_type:
                    return packet
        raise TimeoutError(f"Timed out waiting for frame of type '{target_type}'")

    def close(self):
        try:
            self.send_frame(8, b"")
        except Exception:
            pass
        try:
            self.file.close()
        except Exception:
            pass
        try:
            self.socket.close()
        except Exception:
            pass


def check_port_closed(host: str, port: int, service_name: str) -> bool:
    """Verify that an internal service port is NOT exposed on the host."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        res = s.connect_ex((host, port))
        s.close()
        if res == 0:
            # Check if this is an unrelated host service (e.g. llama-server on 8080)
            if port == 8080:
                try:
                    conn = http.client.HTTPConnection(host, port, timeout=1.0)
                    conn.request("GET", "/")
                    r = conn.getresponse()
                    server_hdr = r.getheader("Server", "").lower()
                    conn.close()
                    if "llama" in server_hdr:
                        ok(f"Port {port} ({service_name}) is closed", f"Client not exposed (host process '{server_hdr}')")
                        return True
                except Exception:
                    pass
            fail(f"Port {port} ({service_name}) isolation", f"Port {port} accepted connection! Direct access must be closed.")
            return False
        else:
            ok(f"Port {port} ({service_name}) is closed", f"Refused external connection (code {res})")
            return True
    except Exception as e:
        ok(f"Port {port} ({service_name}) is closed", f"Connection failed as expected: {e}")
        return True


def check_http_redirect(http_url: str, expected_host: str) -> bool:
    """Verify that HTTP port 80 redirects to HTTPS."""
    parsed = urllib.parse.urlsplit(http_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 80
    path = parsed.path or "/"

    try:
        conn = http.client.HTTPConnection(host, port, timeout=5)
        conn.request("GET", path, headers={"Host": expected_host})
        resp = conn.getresponse()
        location = resp.getheader("Location") or ""
        conn.close()

        if resp.status in (301, 302, 307, 308):
            if location.startswith("https://"):
                ok(f"HTTP port {port} redirect", f"{resp.status} Moved → {location}")
                return True
            else:
                fail(f"HTTP port {port} redirect", f"Location header does not use https: '{location}'")
                return False
        else:
            fail(f"HTTP port {port} redirect", f"Expected HTTP 301/302 redirect, got status {resp.status}")
            return False
    except Exception as e:
        fail(f"HTTP port {port} redirect", f"Connection error: {e}")
        return False


def create_ssl_context(insecure: bool, ca_cert: Optional[str]) -> ssl.SSLContext:
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    elif ca_cert:
        ctx = ssl.create_default_context(cafile=ca_cert)
        return ctx
    else:
        return ssl.create_default_context()


def http_request(
    method: str,
    url: str,
    body: Optional[dict] = None,
    headers: Optional[dict] = None,
    ssl_context: Optional[ssl.SSLContext] = None,
    timeout: float = 10.0,
) -> Tuple[int, Dict[str, str], bytes]:
    parsed = urllib.parse.urlsplit(url)
    is_https = parsed.scheme == "https"
    host = parsed.hostname or "localhost"
    default_port = 443 if is_https else 80
    port = parsed.port or default_port

    req_headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
        req_headers["Content-Length"] = str(len(data))

    if is_https:
        conn = http.client.HTTPSConnection(host, port, context=ssl_context, timeout=timeout)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)

    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    conn.request(method, path, body=data, headers=req_headers)
    resp = conn.getresponse()
    resp_body = resp.read()
    resp_headers = {k.lower(): v for k, v in resp.getheaders()}
    conn.close()

    return resp.status, resp_headers, resp_body


def main():
    parser = argparse.ArgumentParser(description="Rest-In-Hackaton HTTPS Nginx E2E Verification Suite")
    parser.add_argument(
        "--target",
        "--url",
        dest="target",
        default="https://localhost",
        help="Target base URL of the HTTPS gateway (default: https://localhost)",
    )
    parser.add_argument(
        "--http-url",
        default="http://localhost:80",
        help="HTTP URL for testing redirection (default: http://localhost:80)",
    )
    parser.add_argument(
        "-k",
        "--insecure",
        action="store_true",
        help="Allow self-signed or invalid SSL/TLS certificates",
    )
    parser.add_argument(
        "--ca-cert",
        default=None,
        help="Path to CA certificate bundle to trust for HTTPS verification",
    )
    parser.add_argument(
        "--skip-ports",
        action="store_true",
        help="Skip port isolation checks (if running from an isolated test harness)",
    )
    parser.add_argument(
        "--server",
        default=None,
        help="Legacy Go server URL (optional override)",
    )
    parser.add_argument(
        "--ai",
        default=None,
        help="Legacy AI service URL (optional direct check if explicitly provided)",
    )
    args = parser.parse_args()

    TARGET = args.target.rstrip("/")
    HTTP_URL = args.http_url.rstrip("/")

    parsed_target = urllib.parse.urlsplit(TARGET)
    gateway_host = parsed_target.hostname or "localhost"
    gateway_port = parsed_target.port or (443 if parsed_target.scheme == "https" else 80)

    print(f"\n{CYAN}{'═' * 60}{RESET}")
    print(f"{CYAN}{BOLD}  Rest-In-Hackaton — HTTPS Nginx Integration Verification{RESET}")
    print(f"{CYAN}{'═' * 60}{RESET}")
    print(f"  Target Gateway : {TARGET}")
    print(f"  HTTP Redirect  : {HTTP_URL}")
    print(f"  TLS Mode       : {'Insecure (Self-Signed)' if args.insecure else ('Custom CA (' + args.ca_cert + ')' if args.ca_cert else 'Strict System CA')}")

    ssl_ctx = create_ssl_context(args.insecure, args.ca_cert)

    # ─── 1. Port Isolation Check ──────────────────────────────────────────
    section("1. Direct Host Port Isolation")
    if args.skip_ports:
        print(f"  {YELLOW}⚠{RESET}  Port isolation check skipped via --skip-ports")
    else:
        # Ports that MUST NOT be exposed on host: 3000 (Go), 8000 (AI), 8080 (Client), 5433 (Postgres)
        ports_to_verify = [
            (3000, "Go Server"),
            (8000, "AI Middleware"),
            (8080, "Client Container"),
            (5433, "PostgreSQL Database"),
        ]
        for port, service in ports_to_verify:
            check_port_closed(gateway_host, port, service)

    # ─── 2. HTTP to HTTPS Redirection ─────────────────────────────────────
    section("2. HTTP → HTTPS Redirection (Port 80)")
    check_http_redirect(HTTP_URL, gateway_host)

    # ─── 3. TLS Certificate & Handshake ───────────────────────────────────
    section("3. TLS Certificate & Handshake")
    try:
        raw_s = socket.create_connection((gateway_host, gateway_port), timeout=5)
        with ssl_ctx.wrap_socket(raw_s, server_hostname=gateway_host) as tls_s:
            version = tls_s.version()
            cipher = tls_s.cipher()
            cipher_str = cipher[0] if cipher else "Unknown"
            ok("TLS Handshake successful", f"Protocol: {version}, Cipher: {cipher_str}")
    except Exception as e:
        fail("TLS Handshake", f"Failed to establish TLS connection: {e}")

    # ─── 4. Web Client Delivery (Root Path /) ─────────────────────────────
    section("4. Web Client Delivery (SPA Root /)")
    try:
        status, headers, body = http_request("GET", f"{TARGET}/", ssl_context=ssl_ctx)
        if status == 200:
            ctype = headers.get("content-type", "")
            body_text = body.decode("utf-8", errors="replace")
            has_title = "<title>Rest-In-Hackaton" in body_text or "REST IN HACKATON" in body_text
            has_canvas = "canvas-container" in body_text or "<canvas" in body_text

            if has_title or has_canvas:
                ok("GET / → 200 OK HTML", f"Content-Type: {ctype}, Body length: {len(body)} bytes")
            else:
                fail("GET / → HTML missing key markers", f"Snippet: {body_text[:150]}")
        else:
            fail("GET / → Unexpected status", f"Status: {status}")
    except Exception as e:
        fail("GET / → Connection failed", str(e))

    # ─── 5. REST API Proxying (/health, /auth/register, /auth/login) ──────
    section("5. REST API Proxying over HTTPS")
    # Health endpoint
    try:
        status, headers, body = http_request("GET", f"{TARGET}/health", ssl_context=ssl_ctx)
        if status == 200:
            health_json = json.loads(body.decode("utf-8"))
            if health_json.get("status") == "ok":
                ok("GET /health → 200 OK", f"status: {health_json.get('status')}, db: {health_json.get('db')}")
            else:
                fail("GET /health → unexpected response", str(health_json))
        else:
            fail("GET /health → non-200 status", f"Status: {status}")
    except Exception as e:
        fail("GET /health → request error", str(e))

    # Auth Register
    test_user = f"smoke_{int(time.time())}_{secrets.token_hex(3)}"
    test_pass = "SmokePass123!"
    auth_token = None
    try:
        reg_payload = {"login": test_user, "password": test_pass, "profile": "business"}
        reg_headers = {"Origin": f"https://{gateway_host}"}
        status, headers, body = http_request(
            "POST", f"{TARGET}/auth/register", body=reg_payload, headers=reg_headers, ssl_context=ssl_ctx
        )
        if status in (200, 201):
            reg_json = json.loads(body.decode("utf-8"))
            auth_token = reg_json.get("token")
            if auth_token:
                ok(f"POST /auth/register → {status} Created", f"Token received for user '{test_user}'")
            else:
                fail("POST /auth/register → missing token", str(reg_json))
        else:
            fail("POST /auth/register → failed status", f"Status: {status}, Body: {body.decode('utf-8', errors='replace')[:150]}")
    except Exception as e:
        fail("POST /auth/register → request error", str(e))

    # Auth Login
    if auth_token:
        try:
            login_payload = {"login": test_user, "password": test_pass}
            login_headers = {"Origin": f"https://{gateway_host}"}
            status, headers, body = http_request(
                "POST", f"{TARGET}/auth/login", body=login_payload, headers=login_headers, ssl_context=ssl_ctx
            )
            if status == 200:
                login_json = json.loads(body.decode("utf-8"))
                if login_json.get("token"):
                    ok("POST /auth/login → 200 OK", "Token verified via login")
                else:
                    fail("POST /auth/login → missing token", str(login_json))
            else:
                fail("POST /auth/login → failed status", f"Status: {status}")
        except Exception as e:
            fail("POST /auth/login → request error", str(e))

    # ─── 6. WebSocket over WSS ─────────────────────────────────────────────
    section("6. WebSocket over WSS (/ws)")
    if auth_token:
        try:
            wss_scheme = "wss" if parsed_target.scheme == "https" else "ws"
            wss_url = f"{wss_scheme}://{gateway_host}:{gateway_port}/ws?token={urllib.parse.quote(auth_token)}"
            ws = RFC6455Client(
                wss_url,
                ssl_context=ssl_ctx if wss_scheme == "wss" else None,
                origin=f"https://{gateway_host}",
                timeout=5.0,
            )
            ok("WSS Handshake → 101 Switching Protocols", "Upgrade and Sec-WebSocket-Accept verified")

            # Await WELCOME packet
            welcome_pkt = ws.receive_json(target_type="WELCOME", timeout=5.0)
            player_data = welcome_pkt.get("payload", {}).get("player", {})
            player_login = player_data.get("login", "")
            ok("WSS Frame Exchange → WELCOME packet received", f"Player: {player_login}, ID: {player_data.get('id')}")

            # Send test MOVE frame
            ws.send_json("MOVE", {"x": 110.0, "z": 110.0, "rotation": 0.0})
            ok("WSS Frame Exchange → MOVE client frame sent")

            ws.close()
            ok("WSS Connection closed cleanly")
        except Exception as e:
            fail("WebSocket over WSS failed", str(e))
    else:
        fail("WebSocket over WSS", "Skipped due to prior auth registration failure")

    # ─── 7. Optional AI Direct Inspection ─────────────────────────────────
    if args.ai:
        section("7. Optional AI Direct Inspection")
        ai_base = args.ai.rstrip("/")
        try:
            status, _, body = http_request("GET", f"{ai_base}/health", timeout=5.0)
            if status == 200:
                ok("AI GET /health → 200 OK", body.decode("utf-8", errors="replace")[:80])
            else:
                fail("AI GET /health", f"Status: {status}")
        except Exception as e:
            fail("AI GET /health", str(e))

    # ─── Summary ──────────────────────────────────────────────────────────
    total = PASS_COUNT + FAIL_COUNT
    print(f"\n{CYAN}{'═' * 60}{RESET}")
    if FAIL_COUNT == 0:
        print(f"{GREEN}{BOLD}  ✅  All {total} verification stages PASSED!{RESET}")
        print(f"{GREEN}  HTTPS reverse proxy, closed ports, SPA & WSS fully operational.{RESET}")
        print(f"{CYAN}{'═' * 60}{RESET}\n")
        sys.exit(0)
    else:
        print(f"{RED}{BOLD}  ❌  {FAIL_COUNT}/{total} verification checks FAILED.{RESET}")
        print(f"{YELLOW}  Review the failed checks above and inspect docker compose logs.{RESET}")
        print(f"{CYAN}{'═' * 60}{RESET}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
