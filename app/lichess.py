from __future__ import annotations

import json
import time
from typing import Any, Callable
from urllib.parse import quote

import httpx

from .config import APP_NAME, APP_VERSION

BASE = "https://lichess.org"
USER_AGENT = f"{APP_NAME}/{APP_VERSION} (local fair-play scanner)"
TOKEN_URL = "https://lichess.org/account/oauth/token"

# Only the fields the analyser needs.  Keeping this tight matters for large
# exports: a game with full analysis is otherwise surprisingly large.
_GAME_KEYS = (
    "id",
    "rated",
    "variant",
    "speed",
    "perf",
    "createdAt",
    "lastMoveAt",
    "status",
    "players",
    "winner",
    "opening",
    "moves",
    "clocks",
    "analysis",
    "clock",
    "initialFen",
)


class JobCancelled(Exception):
    pass


class LichessError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.hint = hint


def _headers(token: str | None, accept: str) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _error_for_status(status: int, *, token: str | None, username: str | None = None) -> LichessError:
    if status == 401:
        return LichessError(
            "Lichess rejected the API token.",
            status=status,
            hint=f"Create a personal token at {TOKEN_URL} (no scopes are required) and paste it again.",
        )
    if status == 403:
        return LichessError(
            "Lichess refused access to this resource.",
            status=status,
            hint="Check that the token is valid and not restricted.",
        )
    if status == 404:
        if not token:
            return LichessError(
                "Lichess requires a personal API token to export a player's full game history.",
                status=status,
                hint=f"Create a free token at {TOKEN_URL} (no scopes needed). Anonymous game export now returns 404.",
            )
        return LichessError(
            f"Lichess user '{username or '?'}' was not found, or the token cannot access it.",
            status=status,
            hint="Check the spelling of the username.",
        )
    if status == 429:
        return LichessError(
            "Lichess rate limit reached.",
            status=status,
            hint="Wait a minute and try again. Avoid running several scans at once.",
        )
    return LichessError(f"Lichess returned HTTP {status}.", status=status)


class LichessClient:
    def __init__(self, token: str | None = None):
        self.token = (token or "").strip() or None

    def _client(self, read_timeout: float = 180.0) -> httpx.Client:
        return httpx.Client(
            timeout=httpx.Timeout(connect=20.0, read=read_timeout, write=30.0, pool=30.0),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )

    def get_account(self) -> dict[str, Any]:
        if not self.token:
            raise LichessError(
                "No API token supplied.",
                hint=f"Create one at {TOKEN_URL} (no scopes required).",
            )
        with self._client() as client:
            try:
                response = client.get(f"{BASE}/api/account", headers=_headers(self.token, "application/json"))
            except httpx.HTTPError as exc:
                raise LichessError(f"Could not reach Lichess: {exc}") from exc
        if response.status_code != 200:
            raise _error_for_status(response.status_code, token=self.token)
        try:
            data = response.json()
        except ValueError as exc:
            raise LichessError("Lichess returned an invalid account response.") from exc
        return {
            "id": data.get("id"),
            "username": data.get("username"),
            "title": data.get("title"),
            "patron": bool(data.get("patron")),
            "scopes": data.get("scopes") or [],
        }

    def get_profile(self, username: str) -> dict[str, Any]:
        username = username.strip()
        if not username:
            raise LichessError("Enter a Lichess username.")
        with self._client() as client:
            try:
                response = client.get(
                    f"{BASE}/api/user/{quote(username, safe='')}",
                    headers=_headers(self.token, "application/json"),
                )
            except httpx.HTTPError as exc:
                raise LichessError(f"Could not reach Lichess: {exc}") from exc
        if response.status_code == 404:
            raise LichessError(
                f"Lichess user '{username}' was not found.",
                status=404,
                hint="Check the spelling of the username.",
            )
        if response.status_code != 200:
            raise _error_for_status(response.status_code, token=self.token, username=username)
        try:
            raw = response.json()
        except ValueError as exc:
            raise LichessError("Lichess returned an invalid profile response.") from exc

        perfs: dict[str, Any] = {}
        for key, value in (raw.get("perfs") or {}).items():
            if isinstance(value, dict) and value.get("games", 0) > 0:
                perfs[key] = {
                    "rating": value.get("rating"),
                    "games": value.get("games"),
                    "prog": value.get("prog"),
                    "prov": bool(value.get("prov")),
                }
        play_time = raw.get("playTime") or {}
        return {
            "username": raw.get("username") or username,
            "id": raw.get("id") or username.lower(),
            "title": raw.get("title"),
            "patron": bool(raw.get("patron")),
            "created_at": raw.get("createdAt"),
            "seen_at": raw.get("seenAt"),
            "url": raw.get("url") or f"https://lichess.org/@/{username}",
            "perfs": perfs,
            "counts": raw.get("count") or {},
            "play_time_hours": round((play_time.get("total") or 0) / 3600.0, 1),
            "profile": raw.get("profile") or {},
        }

    def iter_games(
        self,
        username: str,
        *,
        max_games: int = 50,
        perf: str = "all",
        include_unrated: bool = False,
        on_game: Callable[[dict[str, Any], int], None] | None = None,
        on_progress: Callable[[int, int | None], None] | None = None,
        total_hint: int | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Stream a user's games as NDJSON.

        Returns a dict with the number fetched and an optional warning.  The
        callback receives a trimmed game object and a zero-based index.
        """
        params: dict[str, Any] = {
            "clocks": "true",
            "evals": "true",
            "accuracy": "true",
            "opening": "true",
            "moves": "true",
            "pgnInJson": "false",
        }
        if max_games and max_games > 0:
            params["max"] = max_games
        if perf and perf != "all":
            params["perfType"] = perf
        if not include_unrated:
            params["rated"] = "true"

        url = f"{BASE}/api/games/user/{quote(username, safe='')}"
        count = 0
        warning: str | None = None
        started = False

        with self._client(read_timeout=300.0) as client:
            try:
                with client.stream(
                    "GET",
                    url,
                    params=params,
                    headers=_headers(self.token, "application/x-ndjson"),
                ) as response:
                    if response.status_code != 200:
                        raise _error_for_status(
                            response.status_code, token=self.token, username=username
                        )
                    started = True
                    for line in response.iter_lines():
                        if cancel_check and cancel_check():
                            raise JobCancelled()
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            raw = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(raw, dict) or not raw.get("id"):
                            continue
                        trimmed = {key: raw.get(key) for key in _GAME_KEYS if key in raw}
                        if on_game:
                            on_game(trimmed, count)
                        count += 1
                        if on_progress:
                            on_progress(count, total_hint)
                        if max_games and count >= max_games:
                            break
            except JobCancelled:
                raise
            except LichessError:
                raise
            except httpx.HTTPError as exc:
                if count == 0:
                    raise LichessError(
                        f"Could not download games: {exc}",
                        hint="Check your connection and try again.",
                    ) from exc
                warning = f"Download stopped after {count} games: {exc}"

        return {"count": count, "warning": warning, "started": started}

    def get_cloud_eval(self, fen: str) -> dict[str, Any] | None:
        """Direct cloud-eval helper (the analyser uses CloudEvaluator for caching)."""
        with self._client(read_timeout=30.0) as client:
            try:
                response = client.get(
                    f"{BASE}/api/cloud-eval",
                    params={"fen": fen, "multiPv": 1},
                    headers=_headers(None, "application/json"),
                )
            except httpx.HTTPError:
                return None
        if response.status_code != 200:
            return None
        try:
            data = response.json()
        except ValueError:
            return None
        pvs = data.get("pvs") or []
        if not pvs:
            return None
        pv = pvs[0]
        moves = (pv.get("moves") or "").split()
        return {
            "cp": pv.get("cp"),
            "mate": pv.get("mate"),
            "best_uci": moves[0] if moves else None,
            "depth": data.get("depth"),
        }
