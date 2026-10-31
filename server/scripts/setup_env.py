"""Create missing local settings without displaying secrets or replacing existing values."""
from pathlib import Path
import os
import secrets
from urllib.parse import quote

root = Path(__file__).resolve().parents[1]
path = root / ".env"
settings = {}
if path.exists():
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            settings[key.strip()] = value
def ensure(key, value):
    if not settings.get(key) or "REPLACE" in settings[key]:
        settings[key] = value
ensure("POSTGRES_PASSWORD", secrets.token_hex(32))
ensure("APP_DB_PASSWORD", secrets.token_hex(32))
ensure("JWT_SECRET", secrets.token_hex(32))
password = quote(settings["APP_DB_PASSWORD"], safe="")
ensure("DATABASE_URL", f"postgres://hackaton:{password}@127.0.0.1:5433/hackaton?sslmode=disable")
ensure("TEST_DATABASE_URL", f"postgres://hackaton:{password}@127.0.0.1:5433/hackaton_test?sslmode=disable")
defaults = {"SERVER_ADDR": ":3000", "WORLD_DIR": "world/chunks",
            "CATALOG_PATH": "world/catalog.json", "AI_URL": "http://127.0.0.1:8000",
            "ALLOWED_ORIGINS": "http://localhost:5173,http://127.0.0.1:5173"}
for key, value in defaults.items():
    settings.setdefault(key, value)
# Old files are preserved; only their unused configuration key is removed.
settings.pop("DB_PATH", None)
path.write_text("# Local settings; do not commit.\n" +
                "".join(f"{key}={value}\n" for key, value in settings.items()), encoding="utf-8")
os.chmod(path, 0o600)
print("Local server/.env prepared; secrets are not displayed.")
