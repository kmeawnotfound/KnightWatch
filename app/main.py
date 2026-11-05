from __future__ import annotations

import csv
import io
import json
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .config import (
    APP_NAME,
    APP_VERSION,
    STATIC_DIR,
    env_token,
    find_stockfish,
    ollama_url,
)
from .engine import (
    check_ollama,
    default_hash_mb,
    default_threads_per_worker,
    default_workers,
)
from .jobs import JobManager, load_demo_report
from .lichess import LichessClient, LichessError

app = FastAPI(title=APP_NAME, version=APP_VERSION)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
jobs = JobManager()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ScanRequest(BaseModel):
    username: str = Field(min_length=1, max_length=60)
    token: str | None = None
    perf: str = "all"
    max_games: int = 50
    include_unrated: bool = False
    engine: Literal["auto", "stockfish", "cloud", "lichess"] = "auto"
    depth: int = 14
    samples: int = 24
    reanalyze: bool = False

    @field_validator("max_games")
    @classmethod
    def _games(cls, value: int) -> int:
        if value < 0 or value > 5000:
            raise ValueError("max_games must be between 0 (all) and 5000")
        return value

    @field_validator("depth")
    @classmethod
    def _depth(cls, value: int) -> int:
        if value < 8 or value > 24:
            raise ValueError("depth must be between 8 and 24")
        return value

    @field_validator("samples")
    @classmethod
    def _samples(cls, value: int) -> int:
        if value < 0 or value > 200:
            raise ValueError("samples must be between 0 and 200")
        return value

    @field_validator("perf")
    @classmethod
    def _perf(cls, value: str) -> str:
        allowed = {
            "all",
            "ultraBullet",
            "bullet",
            "blitz",
            "rapid",
            "classical",
            "correspondence",
            "chess960",
            "crazyhouse",
            "antichess",
            "atomic",
            "horde",
            "kingOfTheHill",
            "racingKings",
            "threeCheck",
        }
        if value not in allowed:
            raise ValueError("unknown time control")
        return value


class PgnRequest(BaseModel):
    pgn: str = Field(min_length=1)
    player: str | None = None
    max_games: int = 100
    engine: Literal["auto", "stockfish", "cloud", "lichess"] = "auto"
    depth: int = 14
    samples: int = 24
    reanalyze: bool = False

    @field_validator("pgn")
    @classmethod
    def _pgn_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("PGN text is empty")
        return value

    @field_validator("max_games")
    @classmethod
    def _games(cls, value: int) -> int:
        if value < 1 or value > 1000:
            raise ValueError("max_games must be between 1 and 1000")
        return value


class TokenRequest(BaseModel):
    token: str = Field(min_length=1)


class SummaryRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Pages / health
# ---------------------------------------------------------------------------


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    stockfish = find_stockfish()
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "stockfish": {
            "available": bool(stockfish),
            "path": str(stockfish) if stockfish else None,
            "workers": default_workers(),
            "threads": default_threads_per_worker(),
            "hash_mb": default_hash_mb(),
        },
        "cloud_eval": True,
        "token_configured": bool(env_token()),
    }


@app.get("/api/ai/status")
def ai_status() -> dict:
    return check_ollama(ollama_url())


# ---------------------------------------------------------------------------
# Token / scan
# ---------------------------------------------------------------------------


@app.post("/api/token/check")
def token_check(body: TokenRequest) -> dict:
    client = LichessClient(body.token)
    try:
        account = client.get_account()
    except LichessError as exc:
        raise HTTPException(status_code=400, detail={"message": exc.message, "hint": exc.hint}) from exc
    return {"ok": True, "account": account}


@app.post("/api/scan")
def start_scan(body: ScanRequest) -> dict:
    token = (body.token or "").strip() or env_token()
    if not token:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "A Lichess personal API token is required to download a player's full game history.",
                "hint": "Create a free token at https://lichess.org/account/oauth/token (no scopes needed), or set LICHESS_TOKEN on the server.",
            },
        )
    params = body.model_dump()
    job_id = jobs.create_lichess_job(params, token)
    return {"job_id": job_id}


@app.post("/api/import/pgn")
def import_pgn(body: PgnRequest) -> dict:
    params = body.model_dump()
    job_id = jobs.create_pgn_job(params)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/jobs/{job_id}/report")
def get_report(job_id: str) -> dict:
    report = jobs.get_report(job_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report is not ready")
    return report


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    if not jobs.cancel(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    if not jobs.delete(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@app.get("/api/demo/{kind}")
def demo(kind: str) -> dict:
    if kind not in ("clean", "suspect"):
        raise HTTPException(status_code=404, detail="Unknown demo")
    report = load_demo_report(kind)
    if not report:
        raise HTTPException(
            status_code=404,
            detail="Demo data is not installed. Run scripts/make_demo.py to build it.",
        )
    return report


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------


@app.get("/api/jobs/{job_id}/export.csv")
def export_csv(job_id: str) -> Response:
    report = jobs.get_report(job_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report is not ready")
    username = (report.get("meta") or {}).get("username") or "player"
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "date",
            "game_id",
            "url",
            "color",
            "opponent",
            "opponent_rating",
            "result",
            "speed",
            "time_control",
            "opening",
            "moves",
            "analyzed_moves",
            "acpl",
            "accuracy",
            "top_match",
            "blunders",
            "fast_accuracy",
            "suspicion",
            "flags",
        ]
    )
    for game in report.get("games", []):
        writer.writerow(
            [
                game.get("date"),
                game.get("game_id"),
                game.get("url"),
                game.get("color"),
                game.get("opponent"),
                game.get("opponent_rating"),
                game.get("result"),
                game.get("speed"),
                game.get("time_control"),
                game.get("opening"),
                game.get("moves_count"),
                game.get("analyzed_moves"),
                game.get("acpl"),
                game.get("accuracy"),
                game.get("top_match"),
                game.get("blunders"),
                game.get("fast_accuracy"),
                game.get("suspicion"),
                "|".join(game.get("flags") or []),
            ]
        )
    filename = f"knightwatch-{username}-{job_id}.csv".replace(" ", "_")
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/jobs/{job_id}/export.json")
def export_json(job_id: str) -> Response:
    report = jobs.get_report(job_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report is not ready")
    username = (report.get("meta") or {}).get("username") or "player"
    filename = f"knightwatch-{username}-{job_id}.json".replace(" ", "_")
    return Response(
        content=json.dumps(report, ensure_ascii=False, indent=2),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Optional local LLM narrative
# ---------------------------------------------------------------------------


@app.post("/api/jobs/{job_id}/ai-summary")
def ai_summary(job_id: str, body: SummaryRequest) -> dict:
    report = jobs.get_report(job_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report is not ready")
    status = check_ollama(ollama_url())
    if not status.get("available"):
        raise HTTPException(status_code=400, detail="Ollama is not running on this machine.")
    summary = report.get("summary") or {}
    payload = {
        "username": (report.get("meta") or {}).get("username"),
        "score": summary.get("score"),
        "verdict": summary.get("verdict"),
        "confidence": summary.get("confidence_label"),
        "metrics": summary.get("metrics"),
        "components": summary.get("components"),
        "reasons": summary.get("reasons"),
        "notes": summary.get("notes"),
        "disclaimer": (report.get("meta") or {}).get("disclaimer"),
    }
    prompt = (
        "You are a cautious chess fair-play analyst. Write a short, plain-English "
        "assessment (3 short paragraphs) of the statistical screen below. Rules:\n"
        "- Never say the player is definitely cheating; these are statistical signals only.\n"
        "- Explain the strongest signals and the main alternative explanations (rating, "
        "time control, small sample, strong opponents).\n"
        "- Mention data limitations and the confidence level.\n"
        "- Do not invent numbers that are not in the JSON.\n"
        "- Keep it under 260 words.\n\n"
        "DATA:\n" + json.dumps(payload, ensure_ascii=False)
    )
    try:
        response = httpx.post(
            f"{ollama_url()}/api/generate",
            json={
                "model": body.model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.3, "num_predict": 420},
            },
            timeout=120.0,
        )
        response.raise_for_status()
        text = (response.json() or {}).get("response", "").strip()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Local model request failed: {exc}") from exc
    if not text:
        raise HTTPException(status_code=502, detail="The local model returned an empty response.")
    return {"summary": text, "model": body.model}


@app.exception_handler(HTTPException)
def http_exception_handler(_request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(status_code=exc.status_code, content={"message": str(detail)})
