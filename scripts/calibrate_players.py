"""Small real-player calibration run.

Fetches a few recent rapid games for a handful of regular Lichess players at
different rating levels, re-analyses them locally with Stockfish, and prints
the resulting screening scores.  Reports are saved under data/calibration/.

Usage:
    $env:LICHESS_TOKEN = "lip_..."
    python scripts/calibrate_players.py --users Aneeshkukutla1232,hiker,Kurald_Galain --games 5
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.analysis import (  # noqa: E402
    aggregate_report,
    attach_engine_analysis,
    compute_game_metrics,
    finalize_games,
    parse_ndjson_game,
)
from app.config import find_stockfish  # noqa: E402
from app.engine import StockfishAnalyzer  # noqa: E402
from app.lichess import LichessClient  # noqa: E402

OUT_DIR = Path("data/calibration")


def strip_analysis(game) -> None:
    """Remove any server analysis so every player is scored the same way."""
    for move in game.moves:
        move.eval_cp = None
        move.eval_before_cp = None
        move.best_uci = None
        move.best_san = None
        move.is_best = None
        move.judgment = None
        move.loss_cp = None
        move.win_drop = None
        move.accuracy = None
        move.source = None
    game.player_analysis = {}
    game.raw_has_analysis = False
    game.analysis_source = None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--users", required=True, help="Comma-separated Lichess usernames")
    parser.add_argument("--games", type=int, default=5)
    parser.add_argument("--perf", default="rapid")
    parser.add_argument("--depth", type=int, default=12)
    parser.add_argument("--samples", type=int, default=12)
    args = parser.parse_args()

    token = os.environ.get("LICHESS_TOKEN", "").strip()
    if not token:
        print("Set LICHESS_TOKEN first.", file=sys.stderr)
        return 2
    stockfish = find_stockfish()
    if not stockfish:
        print("Stockfish not found.", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    client = LichessClient(token)
    analyzer = StockfishAnalyzer(stockfish, depth=args.depth)
    analyzer.start()
    print(f"Engine: {analyzer.name} at depth {args.depth}")
    started_all = time.monotonic()

    summaries = []
    try:
        for username in [u.strip() for u in args.users.split(",") if u.strip()]:
            t0 = time.monotonic()
            profile = client.get_profile(username)
            raw_games: list[dict] = []

            def on_game(raw, index):
                raw_games.append(raw)

            client.iter_games(
                username,
                max_games=args.games,
                perf=args.perf,
                on_game=on_game,
            )
            print(f"\n{profile['username']}: {len(raw_games)} games")

            game_metrics = []
            for raw in raw_games:
                game = parse_ndjson_game(raw)
                if game is None:
                    continue
                color = game.color_of(profile["username"])
                if color is None:
                    continue
                strip_analysis(game)
                attach_engine_analysis(game, color, analyzer, args.samples, args.depth, force=True)
                metrics = compute_game_metrics(game, color)
                metrics["moves"] = []
                game_metrics.append(metrics)

            if not game_metrics:
                print("  no usable games")
                continue

            finalize_games(game_metrics)
            report = aggregate_report(
                game_metrics,
                username=profile["username"],
                profile=profile,
                engine_mode="stockfish",
                depth=args.depth,
                samples=args.samples,
                source="lichess",
            )
            summary = report["summary"]
            row = {
                "username": profile["username"],
                "rating": report["meta"]["avg_rating"],
                "perf_rating": (profile.get("perfs", {}).get(args.perf) or {}).get("rating"),
                "games": len(game_metrics),
                "moves": report["meta"]["moves_analyzed"],
                "score": summary["score"],
                "verdict": summary["verdict"],
                "confidence": summary["confidence"],
                "raw_z": summary["raw_z"],
                "components": {
                    c["key"]: {
                        "value": c["value"],
                        "expected": c["expected"],
                        "z": c["z"],
                    }
                    for c in summary["components"]
                },
                "seconds": round(time.monotonic() - t0, 1),
            }
            summaries.append(row)
            print(
                f"  score {row['score']} ({row['verdict']})  "
                f"rating {row['rating']:.0f}  moves {row['moves']}  "
                f"{row['seconds']}s"
            )
            for key, c in row["components"].items():
                print(
                    f"    {key:16s} value={c['value']} expected={c['expected']} z={c['z']}"
                )
            path = OUT_DIR / f"player_{profile['id']}.json"
            path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    finally:
        analyzer.close()

    total = time.monotonic() - started_all
    print("\nSummary")
    for row in summaries:
        print(
            f"  {row['username']:24s} {row['rating']:6.0f}  "
            f"{row['games']:2d} games  {row['moves']:4d} moves  "
            f"score {row['score']:3d}  {row['verdict']}"
        )
    print(f"Total {total:.1f}s")
    (OUT_DIR / "players_summary.json").write_text(
        json.dumps(summaries, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
