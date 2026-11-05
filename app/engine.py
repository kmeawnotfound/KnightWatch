from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import chess
import chess.engine
import httpx

from .config import CACHE_DB, APP_NAME, APP_VERSION

USER_AGENT = f"{APP_NAME}/{APP_VERSION} (local fair-play scanner)"


def total_ram_mb() -> int | None:
    """Best-effort physical memory detection without extra dependencies."""
    if sys.platform == "win32":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return int(stat.ullTotalPhys // (1024 * 1024))
        except Exception:
            return None
        return None
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // (1024 * 1024))
    except (AttributeError, ValueError, OSError):
        return None


def default_threads() -> int:
    """Use every logical core except one, unless STOCKFISH_THREADS overrides it."""
    raw = os.environ.get("STOCKFISH_THREADS", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return max(1, (os.cpu_count() or 2) - 1)


def default_hash_mb() -> int:
    """Use roughly 1/8 of system RAM for the transposition table."""
    raw = os.environ.get("STOCKFISH_HASH_MB", "").strip()
    if raw:
        try:
            return max(16, int(raw))
        except ValueError:
            pass
    ram = total_ram_mb()
    if ram is None:
        return 512
    return max(256, min(4096, ram // 8))


def default_workers() -> int:
    """One single-threaded engine per core, leaving one core for the app."""
    raw = os.environ.get("STOCKFISH_WORKERS", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return max(1, (os.cpu_count() or 2) - 1)


def default_threads_per_worker() -> int:
    """Threads inside each pooled engine.  One is fastest for this workload."""
    raw = os.environ.get("STOCKFISH_THREADS", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return 1


class StockfishError(RuntimeError):
    pass


class StockfishAnalyzer:
    """Small wrapper around python-chess' UCI engine helper."""

    def __init__(
        self,
        path: str | Path,
        depth: int = 14,
        threads: int | None = None,
        hash_mb: int | None = None,
    ):
        self.path = str(path)
        self.depth = depth
        self.threads = max(1, threads) if threads is not None else default_threads()
        self.hash_mb = max(16, hash_mb) if hash_mb is not None else default_hash_mb()
        self._engine: chess.engine.SimpleEngine | None = None

    def __enter__(self) -> "StockfishAnalyzer":
        self.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def start(self) -> None:
        if self._engine is not None:
            return
        try:
            self._engine = chess.engine.SimpleEngine.popen_uci(self.path)
            options = self._engine.options
            if "Threads" in options:
                self._engine.configure({"Threads": self.threads})
            if "Hash" in options:
                self._engine.configure({"Hash": self.hash_mb})
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            raise StockfishError(f"Could not start Stockfish: {exc}") from exc

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None

    @property
    def name(self) -> str:
        if self._engine is None:
            return "Stockfish"
        return str(self._engine.id.get("name") or "Stockfish")

    def evaluate(self, board: chess.Board) -> dict[str, Any] | None:
        if self._engine is None:
            self.start()
        assert self._engine is not None
        if board.is_game_over(claim_draw=False):
            return {
                "cp": 10000 if board.is_checkmate() and board.turn == chess.BLACK else
                      -10000 if board.is_checkmate() else 0,
                "mate": 0 if board.is_checkmate() else None,
                "best_uci": None,
                "depth": self.depth,
            }
        try:
            info = self._engine.analyse(board, chess.engine.Limit(depth=self.depth))
        except chess.engine.EngineTerminatedError as exc:
            raise StockfishError("Stockfish terminated unexpectedly") from exc
        except Exception:
            return None

        score = info.get("score")
        if score is None:
            return None
        white_score = score.white()
        cp = white_score.score(mate_score=10000)
        if cp is None:
            return None
        pv = info.get("pv") or []
        best = pv[0].uci() if pv else None
        return {
            "cp": int(cp),
            "mate": white_score.mate(),
            "best_uci": best,
            "depth": int(info.get("depth") or self.depth),
        }


class StockfishWorkerPool:
    """Pool of single-threaded Stockfish processes for game-level parallelism.

    A single engine using every core is often slower at shallow-to-mid depths
    because of search overhead and lock contention.  Running one single-threaded
    engine per core, with one core left for the app, gives much better
    throughput when there are many independent games to analyse.
    """

    def __init__(
        self,
        path: str | Path,
        depth: int = 14,
        workers: int | None = None,
        threads_per_worker: int | None = None,
        hash_mb: int | None = None,
    ):
        self.path = str(path)
        self.depth = depth
        self.workers = max(1, workers) if workers is not None else default_workers()
        self.threads_per_worker = (
            max(1, threads_per_worker)
            if threads_per_worker is not None
            else default_threads_per_worker()
        )
        total_hash = max(16, hash_mb) if hash_mb is not None else default_hash_mb()
        self.hash_per_worker = max(16, total_hash // self.workers)
        self._executor = ThreadPoolExecutor(
            max_workers=self.workers, thread_name_prefix="knightwatch-sf"
        )
        self._local = threading.local()
        self._analyzers: list[StockfishAnalyzer] = []
        self._lock = threading.Lock()
        self._closed = False

    def _get_analyzer(self) -> StockfishAnalyzer:
        analyzer = getattr(self._local, "analyzer", None)
        if analyzer is None:
            analyzer = StockfishAnalyzer(
                self.path,
                depth=self.depth,
                threads=self.threads_per_worker,
                hash_mb=self.hash_per_worker,
            )
            analyzer.start()
            self._local.analyzer = analyzer
            with self._lock:
                self._analyzers.append(analyzer)
        return analyzer

    def _reset_local(self) -> None:
        analyzer = getattr(self._local, "analyzer", None)
        if analyzer is None:
            return
        analyzer.close()
        self._local.analyzer = None
        with self._lock:
            if analyzer in self._analyzers:
                self._analyzers.remove(analyzer)

    def submit(self, fn: Callable[[StockfishAnalyzer], Any]) -> Future:
        if self._closed:
            raise RuntimeError("Stockfish worker pool is closed")

        def task() -> Any:
            try:
                return fn(self._get_analyzer())
            except StockfishError:
                # Replace the dead engine on this worker thread.
                self._reset_local()
                raise

        return self._executor.submit(task)

    def shutdown(self, wait: bool = True) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=wait, cancel_futures=not wait)
        with self._lock:
            analyzers = list(self._analyzers)
            self._analyzers.clear()
        for analyzer in analyzers:
            analyzer.close()

    def __enter__(self) -> "StockfishWorkerPool":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.shutdown()


class CloudEvaluator:
    """Lichess cloud evaluation with a small on-disk cache.

    The API returns centipawns from White's point of view.  Requests are
    serialized and lightly throttled because cloud eval is a shared resource.
    """

    def __init__(self, cache_path: Path = CACHE_DB, min_interval: float = 1.05):
        self.cache_path = cache_path
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._db = sqlite3.connect(str(cache_path), check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS cloud_eval (fen TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)"
        )
        self._db.commit()

    def close(self) -> None:
        try:
            self._db.close()
        except Exception:
            pass

    def _cache_get(self, fen: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT payload FROM cloud_eval WHERE fen = ?", (fen,)).fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0])
        except json.JSONDecodeError:
            return None

    def _cache_put(self, fen: str, payload: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO cloud_eval (fen, payload, fetched_at) VALUES (?, ?, ?)",
            (fen, json.dumps(payload), int(time.time())),
        )
        self._db.commit()

    def evaluate(self, fen: str) -> dict[str, Any] | None:
        cached = self._cache_get(fen)
        if cached is not None:
            return None if cached.get("none") else cached

        with self._lock:
            # Another thread may have filled the cache while we waited.
            cached = self._cache_get(fen)
            if cached is not None:
                return None if cached.get("none") else cached
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            try:
                response = httpx.get(
                    "https://lichess.org/api/cloud-eval",
                    params={"fen": fen, "multiPv": 1},
                    headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                    timeout=20.0,
                )
                self._last_request = time.monotonic()
                if response.status_code == 404:
                    self._cache_put(fen, {"none": True})
                    return None
                if response.status_code == 429:
                    time.sleep(4.0)
                    return None
                response.raise_for_status()
                data = response.json()
            except (httpx.HTTPError, ValueError):
                return None

        pvs = data.get("pvs") or []
        if not pvs:
            self._cache_put(fen, {"none": True})
            return None
        pv = pvs[0]
        cp = pv.get("cp")
        mate = pv.get("mate")
        if cp is None and mate is None:
            self._cache_put(fen, {"none": True})
            return None
        moves = (pv.get("moves") or "").split()
        payload = {
            "cp": int(cp) if cp is not None else None,
            "mate": int(mate) if mate is not None else None,
            "best_uci": moves[0] if moves else None,
            "depth": int(data.get("depth") or 0),
        }
        self._cache_put(fen, payload)
        return payload


def check_ollama(url: str) -> dict[str, Any]:
    try:
        response = httpx.get(f"{url}/api/tags", timeout=1.5)
        response.raise_for_status()
        data = response.json()
        models = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return {"available": True, "models": models}
    except Exception:
        return {"available": False, "models": []}
