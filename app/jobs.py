from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from concurrent.futures import as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .analysis import (
    GameRecord,
    aggregate_report,
    attach_cloud_analysis,
    attach_engine_analysis,
    attach_engine_top_match,
    compute_game_metrics,
    finalize_games,
    parse_ndjson_game,
    parse_pgn_games,
)
from .config import DATA_DIR, REPORTS_DIR, find_stockfish
from .engine import (
    CloudEvaluator,
    StockfishAnalyzer,
    StockfishError,
    StockfishWorkerPool,
    default_hash_mb,
    default_threads,
    default_workers,
)
from .lichess import JobCancelled, LichessClient, LichessError

MAX_DETAIL_GAMES = 250


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


class JobManager:
    def __init__(self, max_concurrent: int | None = None):
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._slots = threading.Semaphore(
            max_concurrent or int(os.environ.get("KW_MAX_JOBS", "2"))
        )
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        self._prune()

    # ------------------------------------------------------------------ API
    def create_lichess_job(self, params: dict[str, Any], token: str | None) -> str:
        job_id = uuid.uuid4().hex[:12]
        public_params = {k: v for k, v in params.items() if k != "token"}
        job = self._new_job(job_id, "lichess", public_params)
        job["_token"] = token
        self._start(job)
        return job_id

    def create_pgn_job(self, params: dict[str, Any]) -> str:
        job_id = uuid.uuid4().hex[:12]
        public_params = {k: v for k, v in params.items() if k != "pgn"}
        job = self._new_job(job_id, "pgn", public_params)
        job["_pgn"] = params.get("pgn") or ""
        self._start(job)
        return job_id

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def get_report(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            report = job.get("report")
            if report is not None:
                return report
        path = REPORTS_DIR / f"{job_id}.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        return None

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False
            job["_cancel"] = True
            if job["status"] == "queued":
                job["status"] = "cancelled"
                job["phase"] = "cancelled"
                job["finished_at"] = _now_iso()
            self._log(job, "Cancellation requested.")
            return True

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if not job:
            return False
        try:
            (REPORTS_DIR / f"{job_id}.json").unlink(missing_ok=True)
        except OSError:
            pass
        return True

    # ------------------------------------------------------------- internals
    def _new_job(self, job_id: str, kind: str, params: dict[str, Any]) -> dict[str, Any]:
        job = {
            "id": job_id,
            "kind": kind,
            "status": "queued",
            "phase": "queued",
            "created_at": _now_iso(),
            "started_at": None,
            "finished_at": None,
            "params": params,
            "progress": {
                "percent": 0,
                "fetched": 0,
                "total_hint": None,
                "analyzed": 0,
                "total_games": 0,
                "current_game": None,
                "eta_seconds": None,
            },
            "logs": [],
            "error": None,
            "error_hint": None,
            "profile": None,
            "report": None,
            "_token": None,
            "_pgn": None,
            "_cancel": False,
        }
        with self._lock:
            self._jobs[job_id] = job
        return job

    def _start(self, job: dict[str, Any]) -> None:
        thread = threading.Thread(target=self._run, args=(job["id"],), daemon=True)
        thread.start()

    def _run(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
        if not job:
            return
        if job.get("_cancel"):
            return
        acquired = self._slots.acquire(timeout=0.2)
        if not acquired:
            self._log(job, "Waiting for a free analysis slot…")
            while not self._slots.acquire(timeout=0.5):
                if job.get("_cancel"):
                    self._set_status(job, "cancelled")
                    return
        try:
            if job.get("_cancel"):
                self._set_status(job, "cancelled")
                return
            self._set_status(job, "running")
            job["started_at"] = _now_iso()
            if job["kind"] == "pgn":
                self._run_pgn(job)
            else:
                self._run_lichess(job)
        except JobCancelled:
            self._set_status(job, "cancelled")
            self._log(job, "Scan cancelled.")
        except LichessError as exc:
            self._fail(job, exc.message, exc.hint)
        except StockfishError as exc:
            self._fail(job, str(exc), "Check the Stockfish path or switch to cloud/Lichess analysis.")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._fail(job, f"Unexpected error: {exc}", "Check the server console for details.")
        finally:
            self._slots.release()

    def _run_lichess(self, job: dict[str, Any]) -> None:
        params = job["params"]
        username = str(params.get("username") or "").strip()
        token = job.get("_token")
        max_games = int(params.get("max_games") or 50)
        perf = str(params.get("perf") or "all")
        include_unrated = bool(params.get("include_unrated"))

        client = LichessClient(token)
        self._phase(job, "profile", 2, "Loading Lichess profile…")
        profile = client.get_profile(username)
        job["profile"] = profile
        self._log(job, f"Loaded {profile['username']} ({profile.get('title') or 'player'}).")

        total_hint = None
        if max_games > 0:
            if perf != "all":
                total_hint = min(max_games, int((profile.get("perfs", {}).get(perf) or {}).get("games") or max_games))
            else:
                total_hint = min(max_games, int(profile.get("counts", {}).get("all") or max_games))
        else:
            if perf != "all":
                total_hint = int((profile.get("perfs", {}).get(perf) or {}).get("games") or 0) or None
            else:
                total_hint = int(profile.get("counts", {}).get("all") or 0) or None
        job["progress"]["total_hint"] = total_hint

        self._phase(job, "fetching", 5, "Downloading games from Lichess…")
        raw_games: list[dict[str, Any]] = []

        def on_game(raw: dict[str, Any], index: int) -> None:
            if job.get("_cancel"):
                raise JobCancelled()
            raw_games.append(raw)
            if index % 5 == 0:
                self._progress_fetch(job, len(raw_games), total_hint)
                self._log(job, f"Downloaded {len(raw_games)} games…")

        result = client.iter_games(
            username,
            max_games=max_games,
            perf=perf,
            include_unrated=include_unrated,
            on_game=on_game,
            on_progress=lambda count, hint: self._progress_fetch(job, count, hint),
            total_hint=total_hint,
            cancel_check=lambda: bool(job.get("_cancel")),
        )
        if result.get("warning"):
            self._log(job, str(result["warning"]))
            job["params"].setdefault("warnings", []).append(str(result["warning"]))
        if not raw_games:
            raise LichessError(
                "No games were returned.",
                hint=(
                    "Try a different time control or include unrated games. "
                    "If the account has games, make sure the token is valid."
                ),
            )
        self._log(job, f"Downloaded {len(raw_games)} games.")
        self._analyze_games(job, raw_games, username=profile.get("username") or username, profile=profile)

    def _run_pgn(self, job: dict[str, Any]) -> None:
        params = job["params"]
        pgn_text = job.get("_pgn") or ""
        player = str(params.get("player") or "").strip()
        if not pgn_text.strip():
            raise LichessError("No PGN supplied.")
        if len(pgn_text) > 8_000_000:
            raise LichessError("That PGN is too large. Limit the import to a few thousand games.")

        self._phase(job, "parsing", 4, "Parsing PGN…")
        games = parse_pgn_games(pgn_text, limit=int(params.get("max_games") or 100))
        if not games:
            raise LichessError(
                "No standard-chess games with moves were found in the PGN.",
                hint="Make sure the PGN contains at least one completed game.",
            )
        self._log(job, f"Parsed {len(games)} PGN games.")
        profile = {
            "username": player or "Imported PGN",
            "id": "pgn",
            "url": "",
            "title": None,
            "perfs": {},
            "counts": {"all": len(games)},
            "source": "pgn",
        }
        job["profile"] = profile
        job["progress"]["total_hint"] = len(games)
        self._analyze_games(
            job,
            games,
            username=player or None,
            profile=profile,
            already_parsed=True,
        )

    def _analyze_games(
        self,
        job: dict[str, Any],
        items: list[Any],
        *,
        username: str | None,
        profile: dict[str, Any],
        already_parsed: bool = False,
    ) -> None:
        params = job["params"]
        engine_mode = str(params.get("engine") or "auto").lower()
        depth = int(params.get("depth") or 14)
        samples = int(params.get("samples") or 24)
        reanalyze = bool(params.get("reanalyze"))
        warnings: list[str] = list(params.get("warnings") or [])

        self._phase(job, "analyzing", 35, "Preparing analysis…")
        stockfish_path = find_stockfish()
        pool: StockfishWorkerPool | None = None
        cloud: CloudEvaluator | None = None
        active_mode = engine_mode

        if engine_mode in ("auto", "stockfish"):
            if stockfish_path:
                try:
                    pool = StockfishWorkerPool(stockfish_path, depth=depth)
                    # Probe once so a missing/broken binary fails early instead
                    # of failing every game in the pool.
                    engine_name = pool.submit(lambda engine: engine.name).result(timeout=60)
                    active_mode = "stockfish"
                    self._log(
                        job,
                        f"Local engine pool ready: {engine_name}, "
                        f"{pool.workers} workers x {pool.threads_per_worker} thread(s), "
                        f"depth {depth}, {pool.hash_per_worker} MB hash each.",
                    )
                except StockfishError as exc:
                    warnings.append(f"Stockfish unavailable: {exc}")
                    self._log(job, f"Stockfish unavailable: {exc}")
                    if pool is not None:
                        pool.shutdown()
                    pool = None
                    if engine_mode == "stockfish":
                        active_mode = "cloud"
                    else:
                        active_mode = "auto"
            else:
                if engine_mode == "stockfish":
                    raise StockfishError(
                        "No Stockfish executable was found. Run scripts/download_stockfish.ps1 or set STOCKFISH_PATH."
                    )
                warnings.append("No local Stockfish found; falling back to Lichess cloud eval.")
                self._log(job, "No local Stockfish found; using cloud evaluation.")
                active_mode = "auto"

        if engine_mode == "cloud" or active_mode == "cloud" or (engine_mode == "auto" and pool is None):
            cloud = CloudEvaluator()
            active_mode = "cloud"
            self._log(job, "Cloud evaluation enabled (throttled and cached).")

        if engine_mode == "lichess":
            active_mode = "lichess"
            self._log(job, "Using existing Lichess analysis only.")

        total = len(items)
        game_metrics: list[dict[str, Any]] = []
        started = time.monotonic()
        skipped = 0

        def process_game(item: Any, analyzer: StockfishAnalyzer | None) -> tuple[GameRecord | None, dict[str, Any] | None]:
            """Parse and analyse one game.  Runs on a pool worker when parallel."""
            if job.get("_cancel"):
                raise JobCancelled()
            if already_parsed:
                game: GameRecord | None = item
            else:
                game = parse_ndjson_game(item)
            if game is None:
                return None, None

            color = game.color_of(username) if username else None
            if color is None:
                # Fall back to the side whose name appears in the profile.
                color = game.color_of(str(profile.get("username") or ""))
            if color is None and already_parsed and not username:
                # No player supplied for a PGN import: analyse White.
                color = "white"
            if color is None:
                return game, None

            force = reanalyze and active_mode in ("stockfish", "cloud")
            has_eval = game.raw_has_analysis
            try:
                if active_mode == "stockfish" and analyzer is not None and (not has_eval or force):
                    attached = attach_engine_analysis(
                        game,
                        color,
                        analyzer,
                        samples,
                        depth,
                        force=force,
                        cancel_check=lambda: bool(job.get("_cancel")),
                    )
                    if attached == 0 and not has_eval:
                        warnings.append(f"Engine could not evaluate {game.id}.")
                elif active_mode == "stockfish" and analyzer is not None and has_eval and not force:
                    # Lichess only exposes the engine's best move for flagged
                    # moves, so sample positions locally to estimate top-move
                    # agreement without discarding the existing analysis.
                    attach_engine_top_match(
                        game,
                        color,
                        analyzer,
                        samples,
                        depth,
                        cancel_check=lambda: bool(job.get("_cancel")),
                    )
                elif active_mode == "cloud" and cloud is not None and (not has_eval or force):
                    attach_cloud_analysis(game, color, cloud, samples, force=force)
                elif active_mode == "auto" and not has_eval and analyzer is None and cloud is not None:
                    attach_cloud_analysis(game, color, cloud, samples)
            except StockfishError as exc:
                warnings.append(f"Stockfish stopped: {exc}")
                self._log(job, f"Stockfish stopped on {game.id}: {exc}")

            metrics = compute_game_metrics(game, color)
            metrics["moves"] = [m.as_dict() for m in game.moves]
            metrics["detail_available"] = True
            return game, metrics

        try:
            if pool is not None and active_mode == "stockfish":
                futures = {}
                for item in items:
                    if job.get("_cancel"):
                        raise JobCancelled()
                    futures[pool.submit(lambda analyzer, item=item: process_game(item, analyzer))] = item

                for completed, future in enumerate(as_completed(futures), start=1):
                    if job.get("_cancel"):
                        for pending in futures:
                            pending.cancel()
                        raise JobCancelled()
                    try:
                        game, metrics = future.result()
                    except JobCancelled:
                        for pending in futures:
                            pending.cancel()
                        raise
                    except StockfishError as exc:
                        warnings.append(f"Stockfish stopped: {exc}")
                        self._log(job, f"Stockfish stopped: {exc}")
                        skipped += 1
                        continue
                    if metrics is None or game is None:
                        skipped += 1
                        continue
                    game_metrics.append(metrics)
                    self._progress_analysis(job, completed, total, started, game)
            else:
                for i, item in enumerate(items):
                    if job.get("_cancel"):
                        raise JobCancelled()
                    game, metrics = process_game(item, None)
                    if metrics is None or game is None:
                        skipped += 1
                        continue
                    game_metrics.append(metrics)
                    self._progress_analysis(job, i + 1, total, started, game)
        finally:
            if pool is not None:
                pool.shutdown()
            if cloud is not None:
                cloud.close()

        if not game_metrics:
            raise LichessError(
                "No usable games were found for this player.",
                hint="The player may not appear in the downloaded games, or all games were variants.",
            )
        if skipped:
            self._log(job, f"Skipped {skipped} games (variant, missing player, or invalid moves).")

        self._phase(job, "scoring", 96, "Scoring and building report…")
        finalize_games(game_metrics)
        report = aggregate_report(
            game_metrics,
            username=str(profile.get("username") or username or "Unknown"),
            profile=profile,
            engine_mode=active_mode,
            depth=depth,
            samples=samples,
            source=job["kind"],
            warnings=warnings,
        )
        self._trim_details(report)
        job["report"] = report
        job["profile"] = profile
        self._save_report(job["id"], report)
        self._phase(job, "done", 100, "Done")
        job["status"] = "done"
        job["finished_at"] = _now_iso()
        self._log(job, f"Report ready: {report['summary']['score']}/100 ({report['summary']['verdict']}).")

    def _trim_details(self, report: dict[str, Any]) -> None:
        games = report.get("games") or []
        if len(games) <= MAX_DETAIL_GAMES:
            return
        # Games are sorted by suspicion already; keep move detail for the most
        # interesting games and the most recent ones.
        keep = {g["game_id"] for g in games[:MAX_DETAIL_GAMES]}
        for g in games:
            if g["game_id"] not in keep:
                g["moves"] = []
                g["detail_available"] = False

    # ------------------------------------------------------------- reporting
    def _save_report(self, job_id: str, report: dict[str, Any]) -> None:
        path = REPORTS_DIR / f"{job_id}.json"
        try:
            path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def _snapshot(self, job: dict[str, Any]) -> dict[str, Any]:
        report = job.get("report")
        summary = None
        if report:
            summary = {
                "score": report["summary"]["score"],
                "verdict": report["summary"]["verdict"],
                "confidence_label": report["summary"]["confidence_label"],
                "games": report["summary"]["metrics"]["games"],
            }
        return {
            "id": job["id"],
            "kind": job["kind"],
            "status": job["status"],
            "phase": job["phase"],
            "created_at": job["created_at"],
            "started_at": job["started_at"],
            "finished_at": job["finished_at"],
            "params": job.get("params") or {},
            "progress": job.get("progress") or {},
            "logs": (job.get("logs") or [])[-12:],
            "error": job.get("error"),
            "error_hint": job.get("error_hint"),
            "profile": job.get("profile"),
            "report_ready": bool(report),
            "summary": summary,
        }

    def _set_status(self, job: dict[str, Any], status: str) -> None:
        with self._lock:
            job["status"] = status
            if status in ("cancelled", "error"):
                job["phase"] = status
                job["finished_at"] = _now_iso()

    def _fail(self, job: dict[str, Any], message: str, hint: str | None = None) -> None:
        with self._lock:
            job["status"] = "error"
            job["phase"] = "error"
            job["error"] = message
            job["error_hint"] = hint
            job["finished_at"] = _now_iso()
        self._log(job, f"Error: {message}")

    def _phase(self, job: dict[str, Any], phase: str, percent: int, message: str) -> None:
        with self._lock:
            job["phase"] = phase
            job["progress"]["percent"] = percent
        self._log(job, message)

    def _progress_fetch(self, job: dict[str, Any], count: int, hint: int | None) -> None:
        with self._lock:
            job["progress"]["fetched"] = count
            job["progress"]["total_hint"] = hint
            if hint:
                job["progress"]["percent"] = min(35, 5 + int(30 * count / max(hint, 1)))
            else:
                job["progress"]["percent"] = min(35, 5 + int(30 * (1 - pow(2.718, -count / 40.0))))

    def _progress_analysis(
        self,
        job: dict[str, Any],
        done: int,
        total: int,
        started: float,
        game: GameRecord,
    ) -> None:
        elapsed = time.monotonic() - started
        eta = None
        if done > 0:
            eta = int(elapsed / done * max(0, total - done))
        with self._lock:
            job["progress"].update(
                {
                    "analyzed": done,
                    "total_games": total,
                    "percent": min(95, 35 + int(60 * done / max(total, 1))),
                    "current_game": game.id,
                    "eta_seconds": eta,
                }
            )
        if done and done % 10 == 0:
            self._log(job, f"Analysed {done}/{total} games…")

    def _log(self, job: dict[str, Any], message: str) -> None:
        with self._lock:
            job.setdefault("logs", []).append({"ts": _now_iso(), "message": message})
            if len(job["logs"]) > 60:
                del job["logs"][:-60]

    def _prune(self) -> None:
        cutoff = time.time() - 24 * 3600
        with self._lock:
            stale = [
                jid
                for jid, job in self._jobs.items()
                if job["status"] in ("done", "error", "cancelled")
                and job.get("finished_at")
                and _parse_iso(job["finished_at"]) < cutoff
            ]
            for jid in stale:
                self._jobs.pop(jid, None)
        for path in REPORTS_DIR.glob("*.json"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass


def _parse_iso(value: str) -> float:
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return time.time()


def load_demo_report(kind: str) -> dict[str, Any] | None:
    path = DATA_DIR / f"demo_{kind}.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
