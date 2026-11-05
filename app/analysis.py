"""Chess game parsing, metric extraction and statistical fair-play scoring.

The scoring in this module is deliberately transparent and heuristic.  It is
NOT proof of cheating.  It compares a player's moves and clock usage with
rating/time-control baselines and reports statistical outliers.
"""

from __future__ import annotations

import io
import math
import re
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

import chess
import chess.pgn

WHITE = "white"
BLACK = "black"

# ---------------------------------------------------------------------------
# Baselines
# ---------------------------------------------------------------------------

# Approximate average centipawn loss by rating (Lichess-scale, blitz-ish).
_ACPL_ANCHORS = [
    (800, 150.0),
    (1000, 125.0),
    (1200, 105.0),
    (1400, 90.0),
    (1600, 76.0),
    (1800, 64.0),
    (2000, 54.0),
    (2200, 45.0),
    (2400, 34.0),
    (2600, 26.0),
    (2800, 21.0),
    (3000, 18.0),
]

# Approximate accuracy (%) by rating.
_ACC_ANCHORS = [
    (800, 52.0),
    (1000, 60.0),
    (1200, 67.0),
    (1400, 73.0),
    (1600, 78.0),
    (1800, 82.0),
    (2000, 85.0),
    (2200, 88.0),
    (2400, 90.5),
    (2600, 92.5),
    (2800, 94.0),
    (3000, 95.0),
]

# (acpl multiplier, accuracy offset) by Lichess speed.
_SPEED_ADJUST = {
    "ultraBullet": (1.40, -8.0),
    "bullet": (1.20, -5.0),
    "blitz": (1.06, -2.0),
    "rapid": (0.96, 0.0),
    "classical": (0.82, 1.5),
    "correspondence": (0.80, 2.0),
}

_JUDGMENT_ORDER = {"inaccuracy": 1, "mistake": 2, "blunder": 3}
_NAG_JUDGMENT = {2: "mistake", 3: "blunder", 4: "inaccuracy", 6: "inaccuracy"}

_EVAL_RE = re.compile(r"\[%eval\s+([#-]?\d+(?:\.\d+)?)\]")
_CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\]")
_BEST_RE = re.compile(
    r"(?:Inaccuracy|Mistake|Blunder)\.\s+([^\s]+)\s+was best\.", re.IGNORECASE
)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class MoveRecord:
    ply: int
    color: str
    san: str
    uci: str
    fen_before: str
    fen_after: str
    legal_count: int | None = None
    clock: float | None = None
    think_time: float | None = None
    eval_cp: int | None = None  # after the move, White POV
    eval_before_cp: int | None = None  # only for engine-sampled moves
    mate: int | None = None
    loss_cp: int | None = None
    accuracy: float | None = None
    win_drop: float | None = None
    judgment: str | None = None
    best_uci: str | None = None
    best_san: str | None = None
    is_best: bool | None = None
    source: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ply": self.ply,
            "move_no": (self.ply + 1) // 2,
            "color": self.color,
            "san": self.san,
            "uci": self.uci,
            "clock": round(self.clock, 2) if self.clock is not None else None,
            "think_time": round(self.think_time, 2) if self.think_time is not None else None,
            "eval_cp": self.eval_cp,
            "loss_cp": round(self.loss_cp, 1) if self.loss_cp is not None else None,
            "accuracy": round(self.accuracy, 1) if self.accuracy is not None else None,
            "win_drop": round(self.win_drop, 1) if self.win_drop is not None else None,
            "judgment": self.judgment,
            "best_uci": self.best_uci,
            "best_san": self.best_san,
            "is_best": self.is_best,
            "source": self.source,
        }


@dataclass
class GameRecord:
    id: str
    url: str
    white: str
    black: str
    white_elo: int | None
    black_elo: int | None
    result: str  # "1-0", "0-1", "1/2-1/2"
    winner: str | None
    status: str
    speed: str
    perf: str
    created_at: int | None
    opening: str
    eco: str
    time_control: str
    clock_initial: float | None
    clock_increment: float | None
    book_ply: int
    variant: str = "standard"
    moves: list[MoveRecord] = field(default_factory=list)
    analysis_source: str | None = None
    engine_depth: int | None = None
    player_analysis: dict[str, dict[str, Any]] = field(default_factory=dict)
    raw_has_analysis: bool = False
    warnings: list[str] = field(default_factory=list)

    def color_of(self, name: str) -> str | None:
        needle = normalize_name(name)
        if normalize_name(self.white) == needle:
            return WHITE
        if normalize_name(self.black) == needle:
            return BLACK
        return None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def normalize_name(name: str | None) -> str:
    return re.sub(r"\s+", " ", (name or "").strip()).casefold()


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def interpolate(anchors: list[tuple[float, float]], x: float) -> float:
    if x <= anchors[0][0]:
        return anchors[0][1]
    if x >= anchors[-1][0]:
        return anchors[-1][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0)
            return y0 + (y1 - y0) * t
    return anchors[-1][1]


def speed_adjust(speed: str) -> tuple[float, float]:
    return _SPEED_ADJUST.get(speed, (1.0, 0.0))


def expected_acpl(rating: float, speed: str) -> float:
    base = interpolate(_ACPL_ANCHORS, rating)
    factor, _ = speed_adjust(speed)
    return base * factor


def expected_accuracy(rating: float, speed: str) -> float:
    base = interpolate(_ACC_ANCHORS, rating)
    _, offset = speed_adjust(speed)
    return clamp(base + offset, 20.0, 99.0)


def expected_top_match(rating: float) -> float:
    # Calibrated for a depth-14 local engine.  Even strong players match the
    # shallow engine's first choice surprisingly often in forced/obvious
    # positions, so the baseline is higher than a raw "best move" intuition.
    return interpolate(
        [
            (800, 0.30),
            (1200, 0.34),
            (1600, 0.38),
            (2000, 0.43),
            (2400, 0.50),
            (2800, 0.58),
            (3000, 0.62),
        ],
        rating,
    )


def mate_to_cp(mate: int, side_to_move: str) -> int:
    """Convert a mate distance to centipawns from White's point of view."""
    if mate == 0:
        return -10000 if side_to_move == WHITE else 10000
    magnitude = max(100, 10000 - min(abs(mate), 50) * 100)
    return magnitude if mate > 0 else -magnitude


def side_to_move(fen: str) -> str:
    try:
        return WHITE if fen.split(" ")[1] == "w" else BLACK
    except (IndexError, AttributeError):
        return WHITE


def terminal_cp(board: chess.Board) -> int:
    if board.is_checkmate():
        return -10000 if board.turn == chess.WHITE else 10000
    return 0


def eval_entry_cp(entry: dict[str, Any], fen_after: str) -> int | None:
    if entry.get("eval") is not None:
        try:
            return int(entry["eval"])
        except (TypeError, ValueError):
            return None
    if entry.get("mate") is not None:
        try:
            return mate_to_cp(int(entry["mate"]), side_to_move(fen_after))
        except (TypeError, ValueError):
            return None
    return None


def payload_cp(payload: dict[str, Any] | None, fen: str) -> int | None:
    """Normalise an engine/cloud payload to White-POV centipawns."""
    if not payload:
        return None
    if payload.get("cp") is not None:
        try:
            return int(payload["cp"])
        except (TypeError, ValueError):
            return None
    if payload.get("mate") is not None:
        try:
            return mate_to_cp(int(payload["mate"]), side_to_move(fen))
        except (TypeError, ValueError):
            return None
    return None


def win_percent_white(cp: float) -> float:
    """Lichess-style win probability for White, 0..100."""
    cp = clamp(float(cp), -10000.0, 10000.0)
    return 50.0 + 50.0 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def win_percent_for(cp: float, color: str) -> float:
    wp = win_percent_white(cp)
    return wp if color == WHITE else 100.0 - wp


def accuracy_from_drop(drop: float) -> float:
    drop = max(0.0, float(drop))
    # Lichess formula, including the +1 uncertainty bonus for imperfect analysis.
    return clamp(103.1668 * math.exp(-0.04354 * drop) - 3.1669 + 1.0, 0.0, 100.0)


def game_accuracy(moves: list[MoveRecord], color: str) -> float | None:
    """Lichess-style game accuracy from sampled move accuracies.

    Lichess combines a volatility-weighted mean with the harmonic mean, which
    keeps a few bad moves from being hidden by a long tail of quiet ones.  We
    only have evaluations for sampled positions, so the volatility window is
    built from the available win-percentage sequence.  Moves without an
    explicit "before" evaluation inherit the previous evaluation, matching
    ``compute_losses``.
    """
    points: dict[int, float] = {}
    accuracies: list[tuple[int, float]] = []
    prev_eval: float | None = 0
    for move in sorted(moves, key=lambda m: m.ply):
        before = move.eval_before_cp
        if before is None:
            before = prev_eval if move.ply > 1 else 0
        after = move.eval_cp
        if before is not None and after is not None:
            points[move.ply - 1] = win_percent_for(before, color)
            points[move.ply] = win_percent_for(after, color)
            if move.color == color and move.accuracy is not None:
                accuracies.append((move.ply, move.accuracy))
        prev_eval = after if after is not None else prev_eval
    if not points or not accuracies:
        return None

    ordered = sorted(points.items())
    wps = [wp for _, wp in ordered]
    index = {ply: i for i, (ply, _) in enumerate(ordered)}
    window = int(clamp((len(wps) - 1) / 10.0, 2, 8))
    window = min(window, len(wps))

    weighted_sum = 0.0
    weight_sum = 0.0
    values: list[float] = []
    for ply, accuracy in accuracies:
        i = index.get(ply)
        if i is None:
            continue
        chunk = wps[max(0, i - window + 1) : i + 1]
        if len(chunk) >= 2:
            mean = statistics.fmean(chunk)
            sd = math.sqrt(statistics.fmean((x - mean) ** 2 for x in chunk))
        else:
            sd = 0.0
        weight = clamp(sd, 0.5, 12.0)
        weighted_sum += accuracy * weight
        weight_sum += weight
        values.append(accuracy)

    if not values or not weight_sum:
        return None
    weighted = weighted_sum / weight_sum
    harmonic = len(values) / sum(1.0 / max(a, 0.01) for a in values)
    return (weighted + harmonic) / 2.0


def judgment_from_drop(drop: float) -> str | None:
    if drop >= 30.0:
        return "blunder"
    if drop >= 20.0:
        return "mistake"
    if drop >= 10.0:
        return "inaccuracy"
    return None


def parse_clock(value: str) -> float | None:
    m = _CLK_RE.search(value or "")
    if not m:
        return None
    hours = int(m.group(1))
    minutes = int(m.group(2))
    seconds = float(m.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds


def parse_eval(value: str) -> tuple[int | None, int | None]:
    m = _EVAL_RE.search(value or "")
    if not m:
        return None, None
    raw = m.group(1)
    if raw.startswith("#"):
        mate = int(raw[1:])
        return None, mate
    try:
        return int(round(float(raw) * 100)), None
    except ValueError:
        return None, None


def speed_from_time_control(tc: str, has_clocks: bool) -> str:
    if not tc or tc == "-":
        return "correspondence" if not has_clocks else "classical"
    try:
        initial = int(tc.split("+")[0])
    except (ValueError, IndexError):
        return "classical"
    if initial <= 30:
        return "ultraBullet"
    if initial < 180:
        return "bullet"
    if initial < 600:
        return "blitz"
    if initial < 1800:
        return "rapid"
    return "classical"


def time_control_label(speed: str, initial: float | None, increment: float | None) -> str:
    if initial is None:
        return speed
    inc = int(increment or 0)
    mins = initial / 60.0
    base = f"{mins:g}+{inc}"
    return f"{base} {speed}"


def date_from_ms(ms: int | None) -> str | None:
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Parsing: Lichess NDJSON
# ---------------------------------------------------------------------------


def parse_ndjson_game(raw: dict[str, Any]) -> GameRecord | None:
    """Convert one Lichess API game object into a GameRecord."""
    variant = raw.get("variant") or "standard"
    if variant not in ("standard", "fromPosition"):
        return None
    san_moves = (raw.get("moves") or "").split()
    if not san_moves:
        return None

    players = raw.get("players") or {}
    white = _player_name(players.get("white"))
    black = _player_name(players.get("black"))
    if not white or not black:
        return None

    clock = raw.get("clock") or {}
    initial = _float_or_none(clock.get("initial"))
    increment = _float_or_none(clock.get("increment"))
    clocks_raw = raw.get("clocks") or []
    clocks = [c / 100.0 for c in clocks_raw] if clocks_raw else []

    board = chess.Board()
    moves: list[MoveRecord] = []
    try:
        for i, san in enumerate(san_moves):
            move = board.parse_san(san)
            fen_before = board.fen()
            uci = move.uci()
            legal_count = board.legal_moves.count()
            board.push(move)
            moves.append(
                MoveRecord(
                    ply=i + 1,
                    color=WHITE if i % 2 == 0 else BLACK,
                    san=san,
                    uci=uci,
                    fen_before=fen_before,
                    fen_after=board.fen(),
                    legal_count=legal_count,
                    clock=clocks[i] if i < len(clocks) else None,
                )
            )
    except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError) as exc:
        return None

    analysis = raw.get("analysis") or []
    for i, move in enumerate(moves):
        if i >= len(analysis):
            break
        entry = analysis[i] or {}
        move.eval_cp = eval_entry_cp(entry, move.fen_after)
        move.mate = entry.get("mate")
        if entry.get("best"):
            move.best_uci = str(entry["best"])
            move.best_san = uci_to_san(move.fen_before, move.best_uci)
        judgment = (entry.get("judgment") or {}).get("name")
        if judgment:
            move.judgment = judgment.lower()
        move.source = "lichess"

    opening = raw.get("opening") or {}
    book_ply = int(opening.get("ply") or 10)
    winner = raw.get("winner")
    result = "1/2-1/2"
    if winner == "white":
        result = "1-0"
    elif winner == "black":
        result = "0-1"

    game = GameRecord(
        id=str(raw.get("id") or ""),
        url=f"https://lichess.org/{raw.get('id')}" if raw.get("id") else "",
        white=white,
        black=black,
        white_elo=_int_or_none((players.get("white") or {}).get("rating")),
        black_elo=_int_or_none((players.get("black") or {}).get("rating")),
        result=result,
        winner=winner,
        status=str(raw.get("status") or ""),
        speed=str(raw.get("speed") or "classical"),
        perf=str(raw.get("perf") or raw.get("speed") or "classical"),
        created_at=_int_or_none(raw.get("createdAt")),
        opening=str(opening.get("name") or "Unknown opening"),
        eco=str(opening.get("eco") or ""),
        time_control=time_control_label(str(raw.get("speed") or "classical"), initial, increment),
        clock_initial=initial,
        clock_increment=increment,
        book_ply=max(0, book_ply),
        variant=variant,
        moves=moves,
        analysis_source="lichess" if analysis else None,
        raw_has_analysis=bool(analysis),
    )

    for color in (WHITE, BLACK):
        pa = (players.get(color) or {}).get("analysis")
        if isinstance(pa, dict):
            game.player_analysis[color] = pa

    compute_think_times(game)
    compute_losses(game)
    return game


def _player_name(side: dict[str, Any] | None) -> str:
    side = side or {}
    user = side.get("user") or {}
    return str(user.get("name") or side.get("name") or "")


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Parsing: PGN (including Lichess-style eval/clock comments)
# ---------------------------------------------------------------------------


def parse_pgn_games(text: str, limit: int = 200) -> list[GameRecord]:
    games: list[GameRecord] = []
    stream = io.StringIO(text)
    while len(games) < limit:
        try:
            node = chess.pgn.read_game(stream)
        except Exception:
            break
        if node is None:
            break
        game = _parse_pgn_node(node)
        if game is not None:
            games.append(game)
    return games


def _parse_pgn_node(node: chess.pgn.Game) -> GameRecord | None:
    headers = node.headers
    if not list(node.mainline_moves()):
        return None
    variant = (headers.get("Variant") or "Standard").lower()
    if variant not in ("standard", "from position", "fromposition"):
        return None

    board = node.board()
    moves: list[MoveRecord] = []
    has_clocks = False
    try:
        for i, child in enumerate(node.mainline()):
            move = child.move
            if move is None:
                break
            fen_before = board.fen()
            san = board.san(move)
            uci = move.uci()
            legal_count = board.legal_moves.count()
            board.push(move)
            comment = child.comment or ""
            eval_cp, mate = parse_eval(comment)
            if eval_cp is None and mate is not None:
                eval_cp = mate_to_cp(mate, side_to_move(board.fen()))
            clock = parse_clock(comment)
            if clock is not None:
                has_clocks = True
            judgment = None
            if "blunder" in comment.lower():
                judgment = "blunder"
            elif "mistake" in comment.lower():
                judgment = "mistake"
            elif "inaccuracy" in comment.lower():
                judgment = "inaccuracy"
            elif child.nags:
                for nag in child.nags:
                    if nag in _NAG_JUDGMENT:
                        judgment = _NAG_JUDGMENT[nag]
                        break
            best_san = None
            best_uci = None
            best_match = _BEST_RE.search(comment)
            if best_match:
                best_san = best_match.group(1).rstrip(".,;")
                best_uci = san_to_uci(fen_before, best_san)
            moves.append(
                MoveRecord(
                    ply=i + 1,
                    color=WHITE if i % 2 == 0 else BLACK,
                    san=san,
                    uci=uci,
                    fen_before=fen_before,
                    fen_after=board.fen(),
                    legal_count=legal_count,
                    clock=clock,
                    eval_cp=eval_cp,
                    mate=mate,
                    judgment=judgment,
                    best_san=best_san,
                    best_uci=best_uci,
                    source="pgn",
                )
            )
    except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError):
        return None

    tc = headers.get("TimeControl") or "-"
    speed = speed_from_time_control(tc, has_clocks)
    initial = None
    increment = None
    if tc and tc != "-" and "+" in tc:
        try:
            initial = float(tc.split("+")[0])
            increment = float(tc.split("+")[1])
        except (ValueError, IndexError):
            pass
    clocks_inferred = initial is None

    # Broadcast PGNs often omit TimeControl but still carry %clk comments.
    # Infer a usable clock scale so think-time signals remain available.
    if initial is None and has_clocks:
        clocks = [m.clock for m in moves if m.clock is not None]
        if clocks:
            initial = max(clocks)
            diffs = []
            for i in range(2, len(moves)):
                if moves[i].clock is not None and moves[i - 2].clock is not None:
                    diffs.append(moves[i].clock - moves[i - 2].clock)
            positive = [d for d in diffs if 0 < d <= 90]
            increment = max(positive) if positive else 0.0
    result = headers.get("Result") or "*"
    winner = "white" if result == "1-0" else "black" if result == "0-1" else None
    date_raw = headers.get("UTCDate") or headers.get("Date") or ""
    created_at = None
    if date_raw and date_raw != "????.??.??":
        try:
            dt = datetime.strptime(date_raw, "%Y.%m.%d").replace(tzinfo=timezone.utc)
            created_at = int(dt.timestamp() * 1000)
        except ValueError:
            pass

    def clean_header(key: str) -> str:
        value = (headers.get(key) or "").strip()
        return "" if value in ("?", "-") else value

    site = clean_header("Site")
    game_id = clean_header("GameId")
    if not game_id and site:
        # Lichess broadcast/site URLs end in the game id; use that instead of
        # the whole URL, which would make table keys and exports unreadable.
        tail = [part for part in site.rstrip("/").split("/") if part]
        game_id = tail[-1] if tail else site
    if not game_id:
        game_id = f"pgn-{id(node)}"

    game = GameRecord(
        id=game_id,
        url=clean_header("GameURL") or site,
        white=headers.get("White") or "White",
        black=headers.get("Black") or "Black",
        white_elo=_int_or_none(headers.get("WhiteElo")),
        black_elo=_int_or_none(headers.get("BlackElo")),
        result=result,
        winner=winner,
        status=headers.get("Termination") or "",
        speed=speed,
        perf=speed,
        created_at=created_at,
        opening=headers.get("Opening") or "Unknown opening",
        eco=headers.get("ECO") or "",
        time_control=(
            time_control_label(speed, initial, increment)
            if initial is not None and not clocks_inferred
            else speed
        ),
        clock_initial=initial,
        clock_increment=increment,
        book_ply=10,
        variant="standard",
        moves=moves,
        analysis_source="pgn" if any(m.eval_cp is not None for m in moves) else None,
        raw_has_analysis=any(m.eval_cp is not None for m in moves),
    )
    compute_think_times(game)
    compute_losses(game)
    return game


def san_to_uci(fen: str, san: str) -> str | None:
    try:
        board = chess.Board(fen)
        move = board.parse_san(san)
        return move.uci()
    except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError):
        return None


def uci_to_san(fen: str, uci: str) -> str | None:
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            return None
        return board.san(move)
    except (ValueError, chess.InvalidMoveError):
        return None


# ---------------------------------------------------------------------------
# Clock and evaluation processing
# ---------------------------------------------------------------------------


def compute_think_times(game: GameRecord) -> None:
    initial = game.clock_initial
    increment = game.clock_increment or 0.0
    if initial is None:
        return
    last = {WHITE: initial, BLACK: initial}
    for i, move in enumerate(game.moves):
        if move.clock is None:
            continue
        elapsed = last[move.color] - move.clock
        if i >= 2:
            elapsed += increment
        # Berserk games can start with less time than the nominal initial clock.
        elapsed = clamp(elapsed, 0.0, max(initial, move.clock, 1.0))
        move.think_time = elapsed
        last[move.color] = move.clock


def compute_losses(game: GameRecord) -> None:
    prev_eval: int | None = 0
    for i, move in enumerate(game.moves):
        before = move.eval_before_cp
        if before is None:
            before = prev_eval if i > 0 else 0
        after = move.eval_cp
        if before is not None and after is not None:
            if move.color == WHITE:
                raw_loss = before - after
            else:
                raw_loss = after - before
            move.loss_cp = clamp(float(raw_loss), 0.0, 1000.0)
            wp_before = win_percent_for(before, move.color)
            wp_after = win_percent_for(after, move.color)
            move.win_drop = clamp(wp_before - wp_after, 0.0, 100.0)
            move.accuracy = accuracy_from_drop(move.win_drop)
            if move.judgment is None:
                move.judgment = judgment_from_drop(move.win_drop)
        prev_eval = after if after is not None else prev_eval


# ---------------------------------------------------------------------------
# Engine / cloud evaluation attachment
# ---------------------------------------------------------------------------


def sample_move_indices(game: GameRecord, color: str, samples: int) -> list[int]:
    candidates = [
        i
        for i, move in enumerate(game.moves)
        if move.color == color and i + 1 > game.book_ply
    ]
    if not candidates:
        return []
    if samples <= 0 or len(candidates) <= samples:
        return candidates
    if samples == 1:
        return [candidates[len(candidates) // 2]]
    picked: list[int] = []
    for k in range(samples):
        idx = round(k * (len(candidates) - 1) / (samples - 1))
        picked.append(candidates[idx])
    return sorted(set(picked))


def attach_engine_analysis(
    game: GameRecord,
    color: str,
    analyzer: Any,
    samples: int,
    depth: int,
    force: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """Evaluate sampled positions with a local Stockfish-like analyzer.

    Returns the number of moves that received engine data.
    """
    indices = sample_move_indices(game, color, samples)
    if not indices:
        return 0
    evaluated = 0
    for i in indices:
        if cancel_check is not None and cancel_check():
            break
        move = game.moves[i]
        if not force and move.eval_cp is not None:
            continue
        before_board = chess.Board(move.fen_before)
        before = analyzer.evaluate(before_board)
        if before is None:
            continue
        after_board = chess.Board(move.fen_after)
        if after_board.is_game_over(claim_draw=False):
            after_cp = terminal_cp(after_board)
            after_best = None
        else:
            after = analyzer.evaluate(after_board)
            if after is None:
                continue
            after_cp = after["cp"]
            after_best = after.get("best_uci")
        move.eval_before_cp = before["cp"]
        move.eval_cp = after_cp
        move.best_uci = before.get("best_uci")
        move.best_san = uci_to_san(move.fen_before, move.best_uci) if move.best_uci else None
        move.is_best = bool(move.best_uci and move.uci == move.best_uci)
        move.source = "engine"
        move.judgment = None
        move.mate = before.get("mate")
        evaluated += 1
    if evaluated:
        game.analysis_source = "stockfish"
        game.engine_depth = depth
        compute_losses(game)
    return evaluated


def attach_engine_top_match(
    game: GameRecord,
    color: str,
    analyzer: Any,
    samples: int,
    depth: int,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """Add engine top-move agreement without overwriting existing evaluations.

    Lichess per-move analysis only exposes ``best`` for flagged moves, so
    top-move agreement is unavailable for already-analysed games.  Evaluating
    just the position before each sampled move is cheap and fills that gap.
    """
    indices = sample_move_indices(game, color, samples)
    if not indices:
        return 0
    matched = 0
    for i in indices:
        if cancel_check is not None and cancel_check():
            break
        move = game.moves[i]
        if move.is_best is not None:
            continue
        before = analyzer.evaluate(chess.Board(move.fen_before))
        if before is None:
            continue
        move.best_uci = before.get("best_uci")
        move.best_san = uci_to_san(move.fen_before, move.best_uci) if move.best_uci else None
        move.is_best = bool(move.best_uci and move.uci == move.best_uci)
        matched += 1
    if matched:
        game.engine_depth = depth
    return matched


def attach_cloud_analysis(
    game: GameRecord,
    color: str,
    evaluator: Any,
    samples: int,
    force: bool = False,
) -> int:
    """Evaluate sampled positions with Lichess cloud eval (White POV cp)."""
    indices = sample_move_indices(game, color, samples)
    if not indices:
        return 0
    evaluated = 0
    for i in indices:
        move = game.moves[i]
        if not force and move.eval_cp is not None:
            continue
        before = evaluator.evaluate(move.fen_before)
        before_cp = payload_cp(before, move.fen_before)
        if before_cp is None:
            continue
        after_board = chess.Board(move.fen_after)
        if after_board.is_game_over(claim_draw=False):
            after_cp = terminal_cp(after_board)
        else:
            after = evaluator.evaluate(move.fen_after)
            after_cp = payload_cp(after, move.fen_after)
            if after_cp is None:
                continue
        move.eval_before_cp = before_cp
        move.eval_cp = after_cp
        move.best_uci = before.get("best_uci")
        move.best_san = uci_to_san(move.fen_before, move.best_uci) if move.best_uci else None
        move.is_best = bool(move.best_uci and move.uci == move.best_uci)
        move.source = "cloud"
        move.judgment = None
        move.mate = before.get("mate")
        evaluated += 1
    if evaluated:
        game.analysis_source = "cloud"
        compute_losses(game)
    return evaluated


# ---------------------------------------------------------------------------
# Game-level metrics
# ---------------------------------------------------------------------------


def game_result_for(game: GameRecord, color: str) -> tuple[str, float]:
    if game.result == "1/2-1/2" or not game.winner:
        return "draw", 0.5
    return ("win", 1.0) if game.winner == color else ("loss", 0.0)


def elo_dp(score_rate: float) -> float:
    score_rate = clamp(score_rate, 0.001, 0.999)
    return -400.0 * math.log10(1.0 / score_rate - 1.0)


def compute_game_metrics(game: GameRecord, color: str) -> dict[str, Any]:
    player_moves = [m for m in game.moves if m.color == color]
    analyzed = [m for m in player_moves if m.loss_cp is not None]
    n_moves = len(player_moves)
    n_analyzed = len(analyzed)

    result, score = game_result_for(game, color)
    player_elo = game.white_elo if color == WHITE else game.black_elo
    opp_elo = game.black_elo if color == WHITE else game.white_elo
    opp_name = game.black if color == WHITE else game.white

    acpl = statistics.fmean(m.loss_cp for m in analyzed) if analyzed else None
    computed_accuracy = game_accuracy(game.moves, color)
    provided = game.player_analysis.get(color) or {}
    # Server-side accuracy/ACPL are only comparable when we did not replace the
    # server analysis with local engine evaluations.
    from_lichess = game.analysis_source == "lichess"
    accuracy = _float_or_none(provided.get("accuracy")) if from_lichess else None
    if accuracy is None:
        accuracy = computed_accuracy
    provided_acpl = _float_or_none(provided.get("acpl"))
    if provided_acpl is not None and from_lichess:
        acpl = provided_acpl

    judgments = {"inaccuracy": 0, "mistake": 0, "blunder": 0}
    for move in player_moves:
        if move.judgment in judgments:
            judgments[move.judgment] += 1
    # The aggregate Lichess annotation counts are more complete than what is
    # exposed per move in some exports.
    if game.analysis_source == "lichess":
        for key in judgments:
            value = provided.get(key)
            if value is not None:
                judgments[key] = int(value)

    top_values = [m.is_best for m in analyzed if m.is_best is not None]
    top_match = (sum(1 for v in top_values if v) / len(top_values)) if top_values else None

    fast_threshold = {
        "ultraBullet": 0.5,
        "bullet": 1.0,
        "blitz": 3.0,
        "rapid": 4.0,
        "classical": 5.0,
        "correspondence": 30.0,
    }.get(game.speed, 3.0)
    # Forced moves (few legal options) say little about calculation speed.
    timed_analyzed = [
        m
        for m in analyzed
        if m.think_time is not None and (m.legal_count is None or m.legal_count > 3)
    ]
    fast = [m for m in timed_analyzed if m.think_time is not None and m.think_time <= fast_threshold]
    slow = [m for m in timed_analyzed if m.think_time is not None and m.think_time > fast_threshold]
    fast_acc = statistics.fmean(m.accuracy for m in fast) if fast else None
    slow_acc = statistics.fmean(m.accuracy for m in slow) if slow else None
    fast_share = len(fast) / len(timed_analyzed) if timed_analyzed else None

    timed_all = [m for m in player_moves if m.think_time is not None]
    times = [m.think_time for m in timed_all if m.think_time is not None]
    median_time = statistics.median(times) if times else None
    mean_time = statistics.fmean(times) if times else None
    time_cv = None
    if len(times) >= 8 and mean_time and mean_time > 0:
        time_cv = statistics.pstdev(times) / mean_time

    performance = None
    if opp_elo is not None:
        performance = opp_elo + elo_dp(score)

    flags: list[str] = []
    if judgments["blunder"] == 0 and n_analyzed >= 20 and accuracy and accuracy >= 92:
        flags.append("no-blunders")
    if fast_acc is not None and fast_share is not None and fast_share >= 0.35 and fast_acc >= 88:
        flags.append("fast-accurate")
    if performance is not None and player_elo is not None and performance - player_elo >= 200:
        flags.append("rating-outlier")
    if median_time is not None and median_time <= 2.0 and accuracy and accuracy >= 88:
        flags.append("low-time-high-accuracy")

    return {
        "game_id": game.id,
        "url": game.url,
        "date": date_from_ms(game.created_at),
        "created_at": game.created_at,
        "white": game.white,
        "black": game.black,
        "white_elo": game.white_elo,
        "black_elo": game.black_elo,
        "color": color,
        "opponent": opp_name,
        "opponent_rating": opp_elo,
        "player_rating": player_elo,
        "rating_diff": (player_elo - opp_elo) if (player_elo is not None and opp_elo is not None) else None,
        "result": result,
        "score": score,
        "speed": game.speed,
        "perf": game.perf,
        "time_control": game.time_control,
        "opening": game.opening,
        "eco": game.eco,
        "status": game.status,
        "moves_count": n_moves,
        "analyzed_moves": n_analyzed,
        "acpl": round(acpl, 1) if acpl is not None else None,
        "accuracy": round(accuracy, 1) if accuracy is not None else None,
        "top_match": round(top_match, 3) if top_match is not None else None,
        "top_moves": len(top_values),
        "inaccuracies": judgments["inaccuracy"],
        "mistakes": judgments["mistake"],
        "blunders": judgments["blunder"],
        "blunder_rate": round(100.0 * judgments["blunder"] / n_moves, 1) if n_moves else None,
        "fast_threshold": fast_threshold,
        "fast_moves": len(fast),
        "slow_moves": len(slow),
        "fast_accuracy": round(fast_acc, 1) if fast_acc is not None else None,
        "slow_accuracy": round(slow_acc, 1) if slow_acc is not None else None,
        "fast_share": round(fast_share, 3) if fast_share is not None else None,
        "median_time": round(median_time, 2) if median_time is not None else None,
        "mean_time": round(mean_time, 2) if mean_time is not None else None,
        "time_cv": round(time_cv, 3) if time_cv is not None else None,
        "timed_moves": len(times),
        "performance": round(performance, 0) if performance is not None else None,
        "engine_source": game.analysis_source,
        "engine_depth": game.engine_depth,
        "flags": flags,
        "_fast_acc_sum": (fast_acc * len(fast)) if fast_acc is not None else 0.0,
        "_fast_acc_n": len(fast),
        "_slow_acc_sum": (slow_acc * len(slow)) if slow_acc is not None else 0.0,
        "_slow_acc_n": len(slow),
    }


# ---------------------------------------------------------------------------
# Aggregation and scoring
# ---------------------------------------------------------------------------


def _weighted(values: Iterable[tuple[float | None, float]]) -> float | None:
    total = 0.0
    weight = 0.0
    for value, w in values:
        if value is None or w <= 0:
            continue
        total += value * w
        weight += w
    return total / weight if weight else None


def aggregate_report(
    games: list[dict[str, Any]],
    *,
    username: str,
    profile: dict[str, Any] | None,
    engine_mode: str,
    depth: int,
    samples: int,
    source: str = "lichess",
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    """Build the final report from per-game metric dictionaries."""
    warnings = warnings or []
    valid = [g for g in games if g.get("analyzed_moves", 0) > 0 or g.get("timed_moves", 0) > 0]
    analyzed = [g for g in games if (g.get("analyzed_moves") or 0) > 0]

    total_moves = sum(g["analyzed_moves"] for g in analyzed)
    total_timed = sum(g["timed_moves"] for g in games)

    acpl = _weighted((g["acpl"], g["analyzed_moves"]) for g in analyzed)
    accuracy = _weighted((g["accuracy"], g["analyzed_moves"]) for g in analyzed)
    top_match = _weighted((g["top_match"], g["top_moves"]) for g in analyzed)
    fast_acc = _weighted((g["fast_accuracy"], g["fast_moves"]) for g in analyzed)
    slow_acc = _weighted((g["slow_accuracy"], g["slow_moves"]) for g in analyzed)
    fast_moves = sum(g["fast_moves"] for g in analyzed)
    slow_moves = sum(g["slow_moves"] for g in analyzed)
    timed_moves = sum(g["timed_moves"] for g in games)

    ratings = [g["player_rating"] for g in games if g.get("player_rating")]
    avg_rating = statistics.fmean(ratings) if ratings else 1500.0
    speeds: dict[str, int] = {}
    for g in games:
        speeds[g["speed"]] = speeds.get(g["speed"], 0) + 1
    dominant_speed = max(speeds, key=speeds.get) if speeds else "blitz"

    exp_acpl = expected_acpl(avg_rating, dominant_speed)
    exp_acc = expected_accuracy(avg_rating, dominant_speed)
    exp_top = expected_top_match(avg_rating)

    performances = [g["performance"] for g in games if g.get("performance") is not None]
    performance = statistics.fmean(performances) if performances else None

    blunders = sum(g["blunders"] for g in analyzed)
    mistakes = sum(g["mistakes"] for g in analyzed)
    inaccuracies = sum(g["inaccuracies"] for g in analyzed)
    blunder_rate = 100.0 * blunders / total_moves if total_moves else None

    # Longest win streak in chronological order.
    ordered = sorted(games, key=lambda g: g.get("created_at") or 0)
    streak = current = 0
    for g in ordered:
        if g["result"] == "win":
            current += 1
            streak = max(streak, current)
        else:
            current = 0

    engine_coverage = (len(analyzed) / len(games)) if games else 0.0
    time_coverage = (timed_moves / sum(g["moves_count"] for g in games)) if games else 0.0

    # ---- z-scores ---------------------------------------------------------
    z: dict[str, float] = {}
    components: list[dict[str, Any]] = []

    def add_component(
        key: str,
        label: str,
        value: float | None,
        expected: float | None,
        z_value: float | None,
        weight: float,
        unit: str = "",
        available: bool = True,
        detail: str = "",
    ) -> None:
        if not available or z_value is None:
            return
        z[key] = z_value
        components.append(
            {
                "key": key,
                "label": label,
                "value": round(value, 2) if value is not None else None,
                "expected": round(expected, 2) if expected is not None else None,
                "z": round(z_value, 2),
                "weight": weight,
                "unit": unit,
                "detail": detail,
            }
        )

    if acpl is not None and total_moves >= 20:
        sd = max(9.0, exp_acpl * 0.26)
        add_component(
            "acpl",
            "Average centipawn loss",
            acpl,
            exp_acpl,
            clamp((exp_acpl - acpl) / sd, -3.0, 4.0),
            0.95,
            "cp",
            detail=f"{total_moves} analysed moves",
        )

    if accuracy is not None and total_moves >= 20:
        add_component(
            "accuracy",
            "Average move accuracy",
            accuracy,
            exp_acc,
            clamp((accuracy - exp_acc) / 5.5, -3.0, 4.0),
            0.55,
            "%",
        )

    if top_match is not None and sum(g["top_moves"] for g in analyzed) >= 40:
        add_component(
            "top_match",
            "Engine top-move agreement",
            top_match * 100,
            exp_top * 100,
            clamp((top_match - exp_top) / 0.10, -3.0, 4.0),
            0.40,
            "%",
            detail="Local Stockfish / cloud eval",
        )

    if fast_acc is not None and fast_moves >= 15:
        if slow_moves >= 8 and slow_acc is not None:
            penalty = slow_acc - fast_acc
            expected_penalty = {
                "ultraBullet": 3.0,
                "bullet": 4.0,
                "blitz": 5.0,
                "rapid": 2.5,
                "classical": 0.5,
                "correspondence": 0.5,
            }.get(dominant_speed, 4.0)
            z_fast = clamp((expected_penalty - penalty) / 6.5, -2.5, 4.0)
            detail = f"fast {fast_acc:.1f}% vs slower {slow_acc:.1f}%"
        else:
            z_fast = clamp((fast_acc - exp_acc) / 6.5, -2.5, 4.0)
            detail = f"{fast_moves} moves under {g_fast_threshold(analyzed)}s"
        add_component(
            "fast_accuracy",
            "Accuracy when moving fast",
            fast_acc,
            exp_acc,
            z_fast,
            0.45,
            "%",
            detail=detail,
        )

    if performance is not None and len(games) >= 8:
        add_component(
            "performance",
            "Rating performance vs own rating",
            performance,
            avg_rating,
            clamp((performance - avg_rating - 40.0) / 110.0, -3.0, 3.0),
            0.22,
            "Elo",
        )

    cvs = [g["time_cv"] for g in analyzed if g.get("time_cv") is not None and (g.get("median_time") or 0) >= 2.0]
    if len(cvs) >= 8:
        cv = statistics.fmean(cvs)
        add_component(
            "time_uniformity",
            "Uniformity of think times",
            cv,
            0.55,
            clamp((0.42 - cv) / 0.12, -2.0, 3.0),
            0.10,
            "CV",
            detail="Lower is more machine-like",
        )

    if len(games) >= 15:
        p = sum(g["score"] for g in games) / len(games)
        p = clamp(p, 0.05, 0.95)
        expected_streak = math.log(max(len(games), 2)) / max(0.15, math.log(1.0 / max(1.0 - p, 0.05)))
        add_component(
            "win_streak",
            "Longest winning streak",
            streak,
            expected_streak,
            clamp((streak - expected_streak) / 2.2, -2.0, 3.0),
            0.08,
            "games",
        )

    # ---- combine ----------------------------------------------------------
    if components:
        weight_sum = sum(c["weight"] for c in components)
        raw_z = sum(c["z"] * c["weight"] for c in components) / weight_sum
    else:
        raw_z = 0.0

    move_conf = clamp(total_moves / 180.0, 0.0, 1.0) ** 0.5
    game_conf = clamp(len(games) / 20.0, 0.0, 1.0) * 0.4 + 0.6
    engine_conf = 0.55 + 0.45 * clamp(engine_coverage, 0.0, 1.0)
    confidence = clamp(move_conf * game_conf * engine_conf, 0.05, 1.0)

    raw_score = 100.0 / (1.0 + math.exp(-(raw_z - 1.0) * 1.7))
    score = 20.0 + (raw_score - 20.0) * (0.65 + 0.35 * confidence)
    score = int(round(clamp(score, 0, 100)))

    if score < 30:
        verdict = "Low signal"
    elif score < 45:
        verdict = "Mild signal"
    elif score < 60:
        verdict = "Some signal"
    elif score < 75:
        verdict = "Elevated signal"
    elif score < 88:
        verdict = "High signal"
    else:
        verdict = "Very high signal"

    if confidence < 0.35:
        confidence_label = "Low"
    elif confidence < 0.65:
        confidence_label = "Medium"
    else:
        confidence_label = "High"

    reasons = _build_reasons(
        components=components,
        games=games,
        analyzed=analyzed,
        total_moves=total_moves,
        avg_rating=avg_rating,
        dominant_speed=dominant_speed,
        acpl=acpl,
        exp_acpl=exp_acpl,
        accuracy=accuracy,
        exp_acc=exp_acc,
        top_match=top_match,
        exp_top=exp_top,
        fast_acc=fast_acc,
        slow_acc=slow_acc,
        fast_moves=fast_moves,
        performance=performance,
        streak=streak,
        confidence=confidence,
    )

    notes: list[str] = []
    if engine_coverage < 0.5:
        notes.append(
            f"Only {engine_coverage*100:.0f}% of games had engine evaluations. "
            "Scores are less reliable; add Stockfish or use games with Lichess analysis."
        )
    if time_coverage < 0.5:
        notes.append(
            f"Clock data was available for {time_coverage*100:.0f}% of moves; "
            "time-based signals are limited."
        )
    if source == "pgn":
        notes.append("Imported PGN data. Only games with eval/clock annotations or local engine analysis were scored deeply.")
    if engine_mode == "lichess" and source != "demo":
        notes.append("Engine mode was set to existing Lichess analysis only; unanalysed games contribute mostly heuristics.")

    perf_info = ((profile or {}).get("perfs") or {}).get(dominant_speed) or {}
    if perf_info.get("prov"):
        notes.append(
            f"The {dominant_speed} rating is provisional "
            f"({int(perf_info.get('games') or 0)} games), so rating-based baselines are less reliable."
        )
    elif perf_info.get("prog") is not None and abs(int(perf_info["prog"])) >= 50:
        notes.append(
            f"The {dominant_speed} rating moved {int(perf_info['prog']):+d} points recently; "
            "the current rating may not reflect the games in this sample."
        )

    analysis_sources: dict[str, int] = {}
    for game in games:
        key = game.get("engine_source") or "none"
        analysis_sources[key] = analysis_sources.get(key, 0) + 1

    return {
        "meta": {
            "username": username,
            "source": source,
            "generated_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
            "engine_mode": engine_mode,
            "engine_depth": depth,
            "samples_per_game": samples,
            "analysis_sources": analysis_sources,
            "games_total": len(games),
            "games_analyzed": len(analyzed),
            "moves_analyzed": total_moves,
            "timed_moves": timed_moves,
            "engine_coverage": round(engine_coverage, 3),
            "time_coverage": round(time_coverage, 3),
            "speeds": speeds,
            "avg_rating": round(avg_rating, 0),
            "date_min": min((g["date"] for g in games if g.get("date")), default=None),
            "date_max": max((g["date"] for g in games if g.get("date")), default=None),
            "warnings": warnings,
            "disclaimer": (
                "Statistical screening only. These numbers are not proof of cheating, "
                "and strong or fast players can produce outlier scores. Always review "
                "the underlying games and context before drawing conclusions."
            ),
        },
        "profile": profile or {},
        "summary": {
            "score": score,
            "verdict": verdict,
            "confidence": round(confidence, 2),
            "confidence_label": confidence_label,
            "raw_z": round(raw_z, 2),
            "metrics": {
                "games": len(games),
                "games_analyzed": len(analyzed),
                "analyzed_moves": total_moves,
                "avg_rating": round(avg_rating, 0),
                "acpl": round(acpl, 1) if acpl is not None else None,
                "expected_acpl": round(exp_acpl, 1),
                "accuracy": round(accuracy, 1) if accuracy is not None else None,
                "expected_accuracy": round(exp_acc, 1),
                "top_match": round(top_match * 100, 1) if top_match is not None else None,
                "expected_top_match": round(exp_top * 100, 1),
                "fast_accuracy": round(fast_acc, 1) if fast_acc is not None else None,
                "slow_accuracy": round(slow_acc, 1) if slow_acc is not None else None,
                "fast_moves": fast_moves,
                "slow_moves": slow_moves,
                "blunders": blunders,
                "mistakes": mistakes,
                "inaccuracies": inaccuracies,
                "blunder_rate": round(blunder_rate, 1) if blunder_rate is not None else None,
                "performance": round(performance, 0) if performance is not None else None,
                "win_streak": streak,
                "dominant_speed": dominant_speed,
            },
            "components": sorted(components, key=lambda c: c["weight"] * c["z"], reverse=True),
            "reasons": reasons,
            "notes": notes,
        },
        "games": games,
    }


def g_fast_threshold(analyzed: list[dict[str, Any]]) -> float:
    values = [g.get("fast_threshold") for g in analyzed if g.get("fast_threshold")]
    return statistics.fmean(values) if values else 3.0


def _build_reasons(
    *,
    components: list[dict[str, Any]],
    games: list[dict[str, Any]],
    analyzed: list[dict[str, Any]],
    total_moves: int,
    avg_rating: float,
    dominant_speed: str,
    acpl: float | None,
    exp_acpl: float,
    accuracy: float | None,
    exp_acc: float,
    top_match: float | None,
    exp_top: float,
    fast_acc: float | None,
    slow_acc: float | None,
    fast_moves: int,
    performance: float | None,
    streak: int,
    confidence: float,
) -> list[dict[str, str]]:
    reasons: list[dict[str, str]] = []
    by_key = {c["key"]: c for c in components}

    if "acpl" in by_key and by_key["acpl"]["z"] >= 0.9:
        reasons.append(
            {
                "severity": "high" if by_key["acpl"]["z"] >= 1.8 else "medium",
                "title": "Low average centipawn loss",
                "detail": (
                    f"{acpl:.1f} cp across {total_moves} analysed moves, versus "
                    f"~{exp_acpl:.0f} cp expected for {avg_rating:.0f} {dominant_speed}. "
                    "Lower loss means the player's moves stayed closer to the engine's top choices."
                ),
            }
        )

    if "accuracy" in by_key and by_key["accuracy"]["z"] >= 0.9:
        reasons.append(
            {
                "severity": "high" if by_key["accuracy"]["z"] >= 1.8 else "medium",
                "title": "Accuracy above the rating baseline",
                "detail": (
                    f"{accuracy:.1f}% average accuracy versus ~{exp_acc:.1f}% expected. "
                    "Accuracy is derived from the win-probability drop of each move."
                ),
            }
        )

    if "top_match" in by_key and by_key["top_match"]["z"] >= 0.9 and top_match is not None:
        reasons.append(
            {
                "severity": "high" if by_key["top_match"]["z"] >= 1.8 else "medium",
                "title": "Frequent engine top-move agreement",
                "detail": (
                    f"{top_match*100:.1f}% of sampled moves matched the engine's first choice, "
                    f"versus ~{exp_top*100:.1f}% expected. This is one of the strongest single signals."
                ),
            }
        )

    if "fast_accuracy" in by_key and by_key["fast_accuracy"]["z"] >= 0.9 and fast_acc is not None:
        if slow_acc is not None and fast_moves >= 8:
            detail = (
                f"Accuracy was {fast_acc:.1f}% on fast moves and {slow_acc:.1f}% on slower moves. "
                "Fast moves often come in familiar or simpler positions, so this is supporting "
                "context rather than proof of assistance."
            )
        else:
            detail = (
                f"{fast_moves} moves were played quickly and still averaged {fast_acc:.1f}% accuracy."
            )
        reasons.append(
            {
                "severity": "high" if by_key["fast_accuracy"]["z"] >= 2.5 else "medium",
                "title": "High accuracy with little thinking time",
                "detail": detail,
            }
        )

    if "performance" in by_key and by_key["performance"]["z"] >= 1.0 and performance is not None:
        reasons.append(
            {
                "severity": "medium",
                "title": "Performance far above rating",
                "detail": (
                    f"Elo performance of {performance:.0f} against an average rating of "
                    f"{avg_rating:.0f} (+{performance-avg_rating:.0f}). A short sample can produce this by chance."
                ),
            }
        )

    if "time_uniformity" in by_key and by_key["time_uniformity"]["z"] >= 1.0:
        reasons.append(
            {
                "severity": "medium",
                "title": "Unusually uniform think times",
                "detail": (
                    "Think-time variation is lower than typical human play. Some players are simply "
                    "consistent, so treat this as supporting context rather than a standalone flag."
                ),
            }
        )

    if "win_streak" in by_key and by_key["win_streak"]["z"] >= 1.2:
        reasons.append(
            {
                "severity": "low",
                "title": "Long winning streak",
                "detail": f"Longest streak in the sample: {streak} wins. Streaks are noisy and weak evidence on their own.",
            }
        )

    if not reasons:
        reasons.append(
            {
                "severity": "info",
                "title": "No strong statistical outliers",
                "detail": (
                    "Accuracy, centipawn loss, time usage and results are all broadly in line with "
                    "the player's rating and time control. This does not prove fair play; it simply "
                    "means this screen found no large anomalies."
                ),
            }
        )

    if confidence < 0.35:
        reasons.append(
            {
                "severity": "info",
                "title": "Small or incomplete sample",
                "detail": "Treat this report as a rough screen. More games and full engine coverage would make it much more reliable.",
            }
        )
    return reasons


def score_single_game(metrics: dict[str, Any], speed: str, rating: float) -> int:
    """A lightweight per-game suspicion score for ranking the game list."""
    zs: list[tuple[float, float]] = []
    if metrics.get("acpl") is not None and metrics.get("analyzed_moves", 0) >= 10:
        exp = expected_acpl(rating, speed)
        zs.append((clamp((exp - metrics["acpl"]) / max(9.0, exp * 0.26), -3, 4), 0.95))
    if metrics.get("accuracy") is not None and metrics.get("analyzed_moves", 0) >= 10:
        exp = expected_accuracy(rating, speed)
        zs.append((clamp((metrics["accuracy"] - exp) / 5.5, -3, 4), 0.55))
    if metrics.get("top_match") is not None and metrics.get("top_moves", 0) >= 15:
        exp = expected_top_match(rating)
        zs.append((clamp((metrics["top_match"] - exp) / 0.10, -3, 4), 0.40))
    if metrics.get("fast_accuracy") is not None and metrics.get("fast_moves", 0) >= 8:
        exp = expected_accuracy(rating, speed)
        zs.append((clamp((metrics["fast_accuracy"] - exp) / 5.5, -3, 4), 0.60))
    if not zs:
        return 25
    weight_sum = sum(w for _, w in zs)
    raw_z = sum(z * w for z, w in zs) / weight_sum
    raw = 100.0 / (1.0 + math.exp(-(raw_z - 1.0) * 1.7))
    # Diminishing-returns shrink: 24 sampled moves already carry real signal,
    # while a 6-move sample should stay close to neutral.
    shrink = clamp((metrics.get("analyzed_moves", 0) / 40.0) ** 0.5, 0.30, 1.0)
    return int(round(clamp(20.0 + (raw - 20.0) * shrink, 0, 100)))


def finalize_games(games: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for g in games:
        rating = g.get("player_rating") or 1500
        g["suspicion"] = score_single_game(g, g.get("speed", "blitz"), rating)
        g["flags"] = sorted(set(g.get("flags", [])))
        for key in list(g.keys()):
            if key.startswith("_"):
                del g[key]
    games.sort(key=lambda g: (g.get("suspicion") or 0, g.get("acpl") or 9999), reverse=True)
    return games
