"""Fast offline checks for parsing, metrics, and calibration anchors.

Run:  python tests/smoke.py
No network access and no Stockfish required.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.analysis import (  # noqa: E402
    aggregate_report,
    compute_game_metrics,
    finalize_games,
    parse_ndjson_game,
    parse_pgn_games,
)

FIXTURES = ROOT / "tests" / "fixtures"
DATA = ROOT / "data"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")
    print(f"  ok  {message}")


def test_clean_pgn() -> None:
    print("Clean GM broadcast sample")
    pgn = (FIXTURES / "broadcast_round.pgn").read_text(encoding="utf-8", errors="replace")
    games = parse_pgn_games(pgn, limit=8)
    check(len(games) == 8, "parsed 8 games")
    check(all(g.moves for g in games), "every game has moves")
    check(any(m.clock is not None for g in games for m in g.moves), "clock annotations parsed")
    check(any(m.eval_cp is not None for g in games for m in g.moves), "eval annotations parsed")

    metrics = []
    for game in games:
        item = compute_game_metrics(game, "white")
        item["moves"] = [m.as_dict() for m in game.moves]
        metrics.append(item)
    finalize_games(metrics)
    report = aggregate_report(
        metrics,
        username="smoke-clean",
        profile={},
        engine_mode="lichess",
        depth=0,
        samples=0,
        source="pgn",
    )
    score = report["summary"]["score"]
    check(score < 30, f"clean sample scores low (got {score})")
    check(report["summary"]["metrics"]["acpl"] is not None, "clean sample has ACPL")


def test_suspect_ndjson() -> None:
    print("Synthetic engine-assisted sample")
    lines = (FIXTURES / "synthetic_cheater.ndjson").read_text(encoding="utf-8").splitlines()
    games = [parse_ndjson_game(json.loads(line)) for line in lines if line.strip()]
    games = [g for g in games if g is not None]
    check(len(games) >= 4, f"parsed {len(games)} synthetic games")
    check(all(g.color_of("EngineAssistedDemo") == "black" for g in games), "player colour resolved")

    metrics = [compute_game_metrics(game, "black") for game in games]
    check(all(m["moves_count"] > 10 for m in metrics), "synthetic games have real move lists")
    check(any(m["timed_moves"] > 0 for m in metrics), "synthetic clock data parsed")


def test_demo_anchors() -> None:
    print("Bundled demo anchors")
    for kind, low, high in (("clean", 0, 29), ("suspect", 85, 100)):
        path = DATA / f"demo_{kind}.json"
        check(path.is_file(), f"{kind} demo exists")
        report = json.loads(path.read_text(encoding="utf-8"))
        score = report["summary"]["score"]
        check(low <= score <= high, f"{kind} demo score {score} within {low}-{high}")
        check(bool(report["games"]), f"{kind} demo has games")
        check(bool(report["games"][0]["moves"]), f"{kind} demo keeps move detail")
        if kind == "suspect":
            check(
                any(g["suspicion"] >= 70 for g in report["games"]),
                "suspect demo has high-signal games",
            )


def main() -> None:
    test_clean_pgn()
    test_suspect_ndjson()
    test_demo_anchors()
    print("\nAll smoke checks passed.")


if __name__ == "__main__":
    main()
