"""Build the bundled demo reports.

- clean: real games from a public Lichess broadcast (strong human play).
- suspect: synthetic games where Black uses a strong engine against a weak
  opponent.  Clearly labelled as synthetic in the UI.

Run:  python scripts/make_demo.py
"""

from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.analysis import (  # noqa: E402
    aggregate_report,
    attach_engine_analysis,
    compute_game_metrics,
    finalize_games,
    parse_ndjson_game,
    parse_pgn_games,
)
from app.config import DATA_DIR, find_stockfish  # noqa: E402
from app.engine import StockfishAnalyzer  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)


def build_clean_demo() -> dict:
    pgn_path = FIXTURES / "broadcast_round.pgn"
    if not pgn_path.is_file():
        raise SystemExit(f"Missing fixture: {pgn_path}")
    games = parse_pgn_games(pgn_path.read_text(encoding="utf-8", errors="replace"), limit=8)
    metrics = []
    for game in games:
        item = compute_game_metrics(game, "white")
        item["moves"] = [m.as_dict() for m in game.moves]
        item["detail_available"] = True
        metrics.append(item)
    finalize_games(metrics)
    report = aggregate_report(
        metrics,
        username="GM Broadcast Sample",
        profile={
            "username": "GM Broadcast Sample",
            "id": "demo-clean",
            "url": "",
            "title": "GM",
            "perfs": {"classical": {"rating": 2600, "games": len(games)}},
            "counts": {"all": len(games)},
        },
        engine_mode="lichess",
        depth=0,
        samples=0,
        source="demo",
    )
    report["meta"]["demo"] = "clean"
    report["meta"]["demo_label"] = "Real games from a public Lichess broadcast (strong human play)"
    return report


OPENINGS = [
    ["e4", "e5", "Nf3", "Nc6"],
    ["d4", "d5", "c4", "e6"],
    ["c4", "e5", "Nc3", "Nf6"],
    ["e4", "c5", "Nf3", "d6"],
    ["d4", "Nf6", "c4", "g6"],
    ["e4", "e6", "d4", "d5"],
    ["Nf3", "d5", "g3", "Nf6"],
    ["e4", "d5", "exd5", "Qxd5"],
]


def generate_suspect_games(count: int = 6, max_plies: int = 110) -> list[dict]:
    path = find_stockfish()
    if not path:
        raise SystemExit("Stockfish is required to build the demo. Run scripts/download_stockfish.ps1.")
    strong = StockfishAnalyzer(path, depth=12)
    weak = StockfishAnalyzer(path, depth=2)
    strong.start()
    weak.start()
    rng = random.Random(20261102)
    games: list[dict] = []
    try:
        for n in range(count * 4):
            if len(games) >= count:
                break
            opening = OPENINGS[n % len(OPENINGS)]
            board = chess.Board()
            sans: list[str] = []
            clocks: list[int] = []
            remaining = {chess.WHITE: 180.0, chess.BLACK: 180.0}
            try:
                for san in opening:
                    move = board.parse_san(san)
                    board.push(move)
                    sans.append(san)
                    remaining[not board.turn] = max(1.0, remaining[not board.turn] - 3.0)
                    clocks.append(int(remaining[not board.turn] * 100))
            except (ValueError, chess.IllegalMoveError):
                continue

            while not board.is_game_over(claim_draw=False) and len(sans) < max_plies:
                engine = strong if board.turn == chess.BLACK else weak
                info = engine.evaluate(board)
                if not info or not info.get("best_uci"):
                    break
                move = chess.Move.from_uci(info["best_uci"])
                if move not in board.legal_moves:
                    break
                san = board.san(move)
                board.push(move)
                sans.append(san)
                mover = not board.turn
                think = (1.2 + rng.random() * 0.8) if mover == chess.BLACK else (5.0 + rng.random() * 4.0)
                remaining[mover] = max(1.0, remaining[mover] - think)
                clocks.append(int(remaining[mover] * 100))

            if not board.is_checkmate() or board.turn != chess.WHITE:
                continue
            index = len(games)
            games.append(
                {
                    "id": f"demo{index + 1:02d}{rng.randrange(16**4):04x}",
                    "rated": True,
                    "variant": "standard",
                    "speed": "blitz",
                    "perf": "blitz",
                    "createdAt": int(time.time() * 1000) - (count - index) * 86_400_000,
                    "lastMoveAt": int(time.time() * 1000),
                    "status": "mate",
                    "players": {
                        "white": {"user": {"name": "DemoOpponent", "id": "demo_opponent"}, "rating": 1450},
                        "black": {"user": {"name": "EngineAssistedDemo", "id": "engine_assisted_demo"}, "rating": 1500},
                    },
                    "winner": "black",
                    "opening": {"eco": "A00", "name": "Synthetic demo game", "ply": len(opening)},
                    "moves": " ".join(sans),
                    "clocks": clocks,
                    "clock": {"initial": 180, "increment": 0},
                }
            )
    finally:
        strong.close()
        weak.close()
    return games


def build_suspect_demo() -> dict:
    raw_games = generate_suspect_games()
    if not raw_games:
        raise SystemExit("Could not generate demo games.")
    ndjson_path = FIXTURES / "synthetic_cheater.ndjson"
    ndjson_path.write_text("\n".join(json.dumps(g) for g in raw_games) + "\n", encoding="utf-8")

    path = find_stockfish()
    analyzer = StockfishAnalyzer(path, depth=14)
    analyzer.start()
    metrics = []
    try:
        for raw in raw_games:
            game = parse_ndjson_game(raw)
            if game is None:
                continue
            color = game.color_of("EngineAssistedDemo")
            if color is None:
                continue
            attach_engine_analysis(game, color, analyzer, samples=24, depth=14, force=True)
            item = compute_game_metrics(game, color)
            item["moves"] = [m.as_dict() for m in game.moves]
            item["detail_available"] = True
            metrics.append(item)
    finally:
        analyzer.close()
    finalize_games(metrics)
    report = aggregate_report(
        metrics,
        username="EngineAssistedDemo",
        profile={
            "username": "EngineAssistedDemo",
            "id": "demo-suspect",
            "url": "",
            "title": None,
            "perfs": {"blitz": {"rating": 1500, "games": len(metrics)}},
            "counts": {"all": len(metrics)},
        },
        engine_mode="stockfish",
        depth=14,
        samples=24,
        source="demo",
    )
    report["meta"]["demo"] = "suspect"
    report["meta"]["demo_label"] = (
        "Synthetic games: Black used a strong local engine against a weak engine opponent. "
        "Not a real player."
    )
    return report


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("Building clean demo…")
    clean = build_clean_demo()
    (DATA_DIR / "demo_clean.json").write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
    print("  score:", clean["summary"]["score"], clean["summary"]["verdict"])

    print("Building suspect demo…")
    suspect = build_suspect_demo()
    (DATA_DIR / "demo_suspect.json").write_text(json.dumps(suspect, ensure_ascii=False), encoding="utf-8")
    print("  score:", suspect["summary"]["score"], suspect["summary"]["verdict"])
    print("Done.")


if __name__ == "__main__":
    main()
