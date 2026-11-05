from __future__ import annotations

import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
REPORTS_DIR = DATA_DIR / "reports"
STATIC_DIR = BASE_DIR / "static"
ENGINE_DIR = BASE_DIR / "engine"
CACHE_DB = DATA_DIR / "cache.sqlite3"

APP_NAME = "KnightWatch"
APP_VERSION = "1.0.0"

for _directory in (DATA_DIR, REPORTS_DIR, ENGINE_DIR):
    _directory.mkdir(parents=True, exist_ok=True)


def find_stockfish() -> Path | None:
    """Locate a Stockfish executable, preferring the bundled engine folder."""
    env_path = os.environ.get("STOCKFISH_PATH")
    if env_path:
        candidate = Path(env_path).expanduser()
        if candidate.is_file():
            return candidate

    on_path = shutil.which("stockfish")
    if on_path:
        return Path(on_path)

    candidates: list[Path] = []
    for pattern in ("stockfish*.exe", "stockfish", "stockfish-*"):
        candidates.extend(ENGINE_DIR.rglob(pattern))
    candidates = [c for c in candidates if c.is_file()]
    if not candidates:
        return None

    def rank(path: Path) -> tuple[int, int, str]:
        name = path.name.lower()
        universal = 1 if "universal" in name else 0
        exe = 1 if name.endswith(".exe") else 0
        return (universal, exe, str(path))

    return sorted(candidates, key=rank, reverse=True)[0]


def ollama_url() -> str:
    return os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def env_token() -> str | None:
    token = os.environ.get("LICHESS_TOKEN", "").strip()
    return token or None
