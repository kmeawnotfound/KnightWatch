import { Chess } from "chess.js";

import {
  BLACK,
  JUDGMENT_ORDER,
  NAG_JUDGMENT,
  WHITE,
  accuracyFromDrop,
  clamp,
  dateFromMs,
  evalEntryCp,
  extractBestSan,
  fmean,
  interpolate,
  isGameOver,
  judgmentFromDrop,
  mateToCp,
  median,
  moveAsDict,
  normalizeName,
  parseClock,
  parseDateHeader,
  parseEval,
  payloadCp,
  pstdev,
  pyRound,
  sanToUci,
  sideToMove,
  speedFromTimeControl,
  terminalCp,
  timeControlLabel,
  uciFromMove,
  uciToSan,
  winPercentFor,
} from "./chess-utils";
import type {
  Color,
  EngineEval,
  GameMetrics,
  GameRecord,
  MoveRecord,
  Profile,
  Report,
  ReportComponent,
  ReportReason,
} from "./types";

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

const ACPL_ANCHORS: Array<[number, number]> = [
  [800, 150.0],
  [1000, 125.0],
  [1200, 105.0],
  [1400, 90.0],
  [1600, 76.0],
  [1800, 64.0],
  [2000, 54.0],
  [2200, 45.0],
  [2400, 34.0],
  [2600, 26.0],
  [2800, 21.0],
  [3000, 18.0],
];

const ACC_ANCHORS: Array<[number, number]> = [
  [800, 52.0],
  [1000, 60.0],
  [1200, 67.0],
  [1400, 73.0],
  [1600, 78.0],
  [1800, 82.0],
  [2000, 85.0],
  [2200, 88.0],
  [2400, 90.5],
  [2600, 92.5],
  [2800, 94.0],
  [3000, 95.0],
];

const SPEED_ADJUST: Record<string, [number, number]> = {
  ultraBullet: [1.4, -8.0],
  bullet: [1.2, -5.0],
  blitz: [1.06, -2.0],
  rapid: [0.96, 0.0],
  classical: [0.82, 1.5],
  correspondence: [0.8, 2.0],
};

const FAST_THRESHOLDS: Record<string, number> = {
  ultraBullet: 0.5,
  bullet: 1.0,
  blitz: 3.0,
  rapid: 4.0,
  classical: 5.0,
  correspondence: 30.0,
};

const EXPECTED_FAST_PENALTY: Record<string, number> = {
  ultraBullet: 3.0,
  bullet: 4.0,
  blitz: 5.0,
  rapid: 2.5,
  classical: 0.5,
  correspondence: 0.5,
};

export interface Analyzer {
  evaluate(fen: string): Promise<EngineEval | null>;
}

export interface CloudEvaluatorLike {
  evaluate(fen: string): Promise<Record<string, any> | null>;
}

export function expectedAcpl(rating: number, speed: string): number {
  const base = interpolate(ACPL_ANCHORS, rating);
  const [factor] = SPEED_ADJUST[speed] || [1.0, 0.0];
  return base * factor;
}

export function expectedAccuracy(rating: number, speed: string): number {
  const base = interpolate(ACC_ANCHORS, rating);
  const [, offset] = SPEED_ADJUST[speed] || [1.0, 0.0];
  return clamp(base + offset, 20.0, 99.0);
}

export function expectedTopMatch(rating: number): number {
  return interpolate(
    [
      [800, 0.3],
      [1200, 0.34],
      [1600, 0.38],
      [2000, 0.43],
      [2400, 0.5],
      [2800, 0.58],
      [3000, 0.62],
    ],
    rating,
  );
}

// ---------------------------------------------------------------------------
// Parsing: Lichess NDJSON
// ---------------------------------------------------------------------------

function playerName(side: any): string {
  const value = side || {};
  const user = value.user || {};
  return String(user.name || value.name || "");
}

function intOrNull(value: any): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function floatOrNull(value: any): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNdjsonGame(raw: Record<string, any>): GameRecord | null {
  const variant = raw.variant || "standard";
  if (variant !== "standard" && variant !== "fromPosition") return null;
  const sanMoves = String(raw.moves || "").split(/\s+/).filter(Boolean);
  if (!sanMoves.length) return null;

  const players = raw.players || {};
  const white = playerName(players.white);
  const black = playerName(players.black);
  if (!white || !black) return null;

  const clock = raw.clock || {};
  const initial = floatOrNull(clock.initial);
  const increment = floatOrNull(clock.increment);
  const clocksRaw = raw.clocks || [];
  const clocks: number[] = Array.isArray(clocksRaw) ? clocksRaw.map((value: number) => value / 100) : [];

  let board: Chess;
  try {
    board = variant === "fromPosition" && raw.initialFen ? new Chess(raw.initialFen) : new Chess();
  } catch {
    return null;
  }

  const moves: MoveRecord[] = [];
  try {
    for (let i = 0; i < sanMoves.length; i += 1) {
      const san = sanMoves[i];
      const fenBefore = board.fen();
      const legalCount = board.moves().length;
      const move = board.move(san);
      moves.push({
        ply: i + 1,
        color: i % 2 === 0 ? WHITE : BLACK,
        san,
        uci: uciFromMove(move),
        fen_before: fenBefore,
        fen_after: board.fen(),
        legal_count: legalCount,
        clock: i < clocks.length ? clocks[i] : null,
        think_time: null,
        eval_cp: null,
        eval_before_cp: null,
        mate: null,
        loss_cp: null,
        accuracy: null,
        win_drop: null,
        judgment: null,
        best_uci: null,
        best_san: null,
        is_best: null,
        source: null,
      });
    }
  } catch {
    return null;
  }

  const analysis = raw.analysis || [];
  for (let i = 0; i < moves.length && i < analysis.length; i += 1) {
    const move = moves[i];
    const entry = analysis[i] || {};
    move.eval_cp = evalEntryCp(entry, move.fen_after);
    move.mate = entry.mate !== undefined ? intOrNull(entry.mate) : null;
    if (entry.best) {
      move.best_uci = String(entry.best);
      move.best_san = uciToSan(move.fen_before, move.best_uci);
    }
    const judgment = entry.judgment && entry.judgment.name;
    if (judgment) move.judgment = String(judgment).toLowerCase();
    move.source = "lichess";
  }

  const opening = raw.opening || {};
  const bookPly = Math.max(0, intOrNull(opening.ply) ?? 10);
  const winner = raw.winner || null;
  const result = winner === "white" ? "1-0" : winner === "black" ? "0-1" : "1/2-1/2";

  const game: GameRecord = {
    id: String(raw.id || ""),
    url: raw.id ? `https://lichess.org/${raw.id}` : "",
    white,
    black,
    white_elo: intOrNull((players.white || {}).rating),
    black_elo: intOrNull((players.black || {}).rating),
    result,
    winner,
    status: String(raw.status || ""),
    speed: String(raw.speed || "classical"),
    perf: String(raw.perf || raw.speed || "classical"),
    created_at: intOrNull(raw.createdAt),
    opening: String(opening.name || "Unknown opening"),
    eco: String(opening.eco || ""),
    time_control: timeControlLabel(String(raw.speed || "classical"), initial, increment),
    clock_initial: initial,
    clock_increment: increment,
    book_ply: bookPly,
    variant,
    moves,
    analysis_source: analysis.length ? "lichess" : null,
    engine_depth: null,
    player_analysis: {},
    raw_has_analysis: Boolean(analysis.length),
    warnings: [],
  };

  for (const color of [WHITE, BLACK] as Color[]) {
    const pa = (players[color] || {}).analysis;
    if (pa && typeof pa === "object" && !Array.isArray(pa)) {
      game.player_analysis[color] = pa;
    }
  }

  computeThinkTimes(game);
  computeLosses(game);
  return game;
}

// ---------------------------------------------------------------------------
// Parsing: PGN (including Lichess-style eval/clock comments)
// ---------------------------------------------------------------------------

function splitPgnGames(text: string): string[] {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let sawMoves = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && sawMoves) {
      chunks.push(current.join("\n"));
      current = [];
      sawMoves = false;
    }
    current.push(line);
    if (trimmed && !trimmed.startsWith("[") && !trimmed.startsWith(";") && !trimmed.startsWith("{")) {
      sawMoves = true;
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks.filter((chunk) => chunk.trim());
}

/** Extract NAGs from the mainline, skipping comments and variations. */
function extractNags(pgn: string): number[][] {
  const movetext = pgn
    .split(/\n/)
    .filter((line) => !line.trim().startsWith("["))
    .join(" ");
  const result: number[][] = [];
  let i = 0;
  let ply = -1;
  const skipComment = () => {
    i += 1;
    while (i < movetext.length && movetext[i] !== "}") i += 1;
    i += 1;
  };
  const skipVariation = () => {
    let depth = 0;
    while (i < movetext.length) {
      const ch = movetext[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return;
        }
      } else if (ch === "{") {
        skipComment();
        continue;
      }
      i += 1;
    }
  };
  while (i < movetext.length) {
    const ch = movetext[i];
    if (ch === "{") {
      skipComment();
      continue;
    }
    if (ch === ";") {
      while (i < movetext.length && movetext[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "(") {
      skipVariation();
      continue;
    }
    if (ch === "$") {
      i += 1;
      let digits = "";
      while (i < movetext.length && /\d/.test(movetext[i])) {
        digits += movetext[i];
        i += 1;
      }
      if (ply >= 0 && digits) {
        result[ply] = result[ply] || [];
        result[ply].push(Number(digits));
      }
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < movetext.length && !/[\s{;(]/.test(movetext[j])) j += 1;
    let token = movetext.slice(i, j);
    i = j;
    token = token.replace(/^\d+\.(?:\.\.)?/, "");
    if (!token || /^\d+\.+$/.test(token) || token === "..." || token === "*") continue;
    if (token === "1-0" || token === "0-1" || token === "1/2-1/2") continue;
    const san = token.replace(/[!?]+$/, "");
    if (!san) continue;
    ply += 1;
    result[ply] = result[ply] || [];
  }
  return result;
}

export function parsePgnGames(text: string, limit = 200): GameRecord[] {
  const games: GameRecord[] = [];
  if (!text || !text.trim()) return games;
  // chess.js' PGN grammar accepts one comment per position; merge adjacent
  // comment blocks (common in Lichess broadcasts) so they parse cleanly.
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\}\s*\{/g, " ");
  const chunks = splitPgnGames(normalized);
  for (let index = 0; index < chunks.length && games.length < limit; index += 1) {
    const chunk = chunks[index];
    let board: Chess;
    let history: ReturnType<Chess["history"]>;
    let headers: Record<string, string>;
    let comments: Map<string, string>;
    try {
      board = new Chess();
      board.loadPgn(chunk);
      headers = board.getHeaders();
      history = board.history({ verbose: true }) as any;
      comments = new Map(board.getComments().map((entry) => [entry.fen, entry.comment]));
    } catch {
      continue;
    }
    if (!Array.isArray(history) || !history.length) continue;

    const variant = String(headers.Variant || "Standard").toLowerCase();
    if (variant !== "standard" && variant !== "from position" && variant !== "fromposition") continue;

    const nags = extractNags(chunk);
    const moves: MoveRecord[] = [];
    let hasClocks = false;
    try {
      for (let i = 0; i < history.length; i += 1) {
        const move: any = history[i];
        const fenBefore = move.before;
        const fenAfter = move.after;
        const legalCount = new Chess(fenBefore).moves().length;
        const comment = comments.get(fenAfter) || "";
        let [evalCp, mate] = parseEval(comment);
        if (evalCp === null && mate !== null) {
          evalCp = mateToCp(mate, sideToMove(fenAfter));
        }
        const clock = parseClock(comment);
        if (clock !== null) hasClocks = true;
        let judgment: string | null = null;
        const lower = comment.toLowerCase();
        if (lower.includes("blunder")) judgment = "blunder";
        else if (lower.includes("mistake")) judgment = "mistake";
        else if (lower.includes("inaccuracy")) judgment = "inaccuracy";
        else {
          const moveNags = nags[i] || [];
          for (const nag of moveNags) {
            if (NAG_JUDGMENT[nag]) {
              judgment = NAG_JUDGMENT[nag];
              break;
            }
          }
        }
        let bestSan: string | null = extractBestSan(comment);
        let bestUci: string | null = bestSan ? sanToUci(fenBefore, bestSan) : null;
        if (bestSan && !bestUci) bestSan = null;
        moves.push({
          ply: i + 1,
          color: i % 2 === 0 ? WHITE : BLACK,
          san: move.san,
          uci: uciFromMove(move),
          fen_before: fenBefore,
          fen_after: fenAfter,
          legal_count: legalCount,
          clock,
          think_time: null,
          eval_cp: evalCp,
          eval_before_cp: null,
          mate,
          loss_cp: null,
          accuracy: null,
          win_drop: null,
          judgment,
          best_uci: bestUci,
          best_san: bestSan,
          is_best: null,
          source: "pgn",
        });
      }
    } catch {
      continue;
    }

    const tc = headers.TimeControl || "-";
    const speed = speedFromTimeControl(tc, hasClocks);
    let initial: number | null = null;
    let increment: number | null = null;
    if (tc && tc !== "-" && tc.includes("+")) {
      const parts = tc.split("+");
      const parsedInitial = Number(parts[0]);
      const parsedIncrement = Number(parts[1]);
      if (Number.isFinite(parsedInitial)) initial = parsedInitial;
      if (Number.isFinite(parsedIncrement)) increment = parsedIncrement;
    }
    const clocksInferred = initial === null;
    if (initial === null && hasClocks) {
      const clocks = moves.map((move) => move.clock).filter((value): value is number => value !== null);
      if (clocks.length) {
        initial = Math.max(...clocks);
        const diffs: number[] = [];
        for (let i = 2; i < moves.length; i += 1) {
          const current = moves[i].clock;
          const previous = moves[i - 2].clock;
          if (current !== null && previous !== null) diffs.push(current - previous);
        }
        const positive = diffs.filter((diff) => diff > 0 && diff <= 90);
        increment = positive.length ? Math.max(...positive) : 0.0;
      }
    }
    const result = headers.Result || "*";
    const winner = result === "1-0" ? "white" : result === "0-1" ? "black" : null;
    const dateRaw = headers.UTCDate || headers.Date || "";
    const createdAt = dateRaw && dateRaw !== "????.??.??" ? parseDateHeader(dateRaw) : null;

    const cleanHeader = (key: string): string => {
      const value = String(headers[key] || "").trim();
      return value === "?" || value === "-" ? "" : value;
    };
    const site = cleanHeader("Site");
    let gameId = cleanHeader("GameId");
    if (!gameId && site) {
      const tail = site.replace(/\/+$/, "").split("/").filter(Boolean);
      gameId = tail.length ? tail[tail.length - 1] : site;
    }
    if (!gameId) gameId = `pgn-${index}`;

    const game: GameRecord = {
      id: gameId,
      url: cleanHeader("GameURL") || site,
      white: headers.White || "White",
      black: headers.Black || "Black",
      white_elo: intOrNull(headers.WhiteElo),
      black_elo: intOrNull(headers.BlackElo),
      result,
      winner,
      status: headers.Termination || "",
      speed,
      perf: speed,
      created_at: createdAt,
      opening: headers.Opening || "Unknown opening",
      eco: headers.ECO || "",
      time_control: initial !== null && !clocksInferred ? timeControlLabel(speed, initial, increment) : speed,
      clock_initial: initial,
      clock_increment: increment,
      book_ply: 10,
      variant: "standard",
      moves,
      analysis_source: moves.some((move) => move.eval_cp !== null) ? "pgn" : null,
      engine_depth: null,
      player_analysis: {},
      raw_has_analysis: moves.some((move) => move.eval_cp !== null),
      warnings: [],
    };
    computeThinkTimes(game);
    computeLosses(game);
    games.push(game);
  }
  return games;
}

// ---------------------------------------------------------------------------
// Clock and evaluation processing
// ---------------------------------------------------------------------------

export function computeThinkTimes(game: GameRecord): void {
  const initial = game.clock_initial;
  const increment = game.clock_increment || 0;
  if (initial === null) return;
  const last: Record<Color, number> = { white: initial, black: initial };
  for (let i = 0; i < game.moves.length; i += 1) {
    const move = game.moves[i];
    if (move.clock === null) continue;
    let elapsed = last[move.color] - move.clock;
    if (i >= 2) elapsed += increment;
    elapsed = clamp(elapsed, 0, Math.max(initial, move.clock, 1));
    move.think_time = elapsed;
    last[move.color] = move.clock;
  }
}

export function computeLosses(game: GameRecord): void {
  let prevEval: number | null = 0;
  for (let i = 0; i < game.moves.length; i += 1) {
    const move = game.moves[i];
    let before = move.eval_before_cp;
    if (before === null) before = i > 0 ? prevEval : 0;
    const after = move.eval_cp;
    if (before !== null && after !== null) {
      const rawLoss = move.color === WHITE ? before - after : after - before;
      move.loss_cp = clamp(rawLoss, 0, 1000);
      const wpBefore = winPercentFor(before, move.color);
      const wpAfter = winPercentFor(after, move.color);
      move.win_drop = clamp(wpBefore - wpAfter, 0, 100);
      move.accuracy = accuracyFromDrop(move.win_drop);
      if (move.judgment === null) move.judgment = judgmentFromDrop(move.win_drop);
    }
    prevEval = after !== null ? after : prevEval;
  }
}

// ---------------------------------------------------------------------------
// Engine / cloud evaluation attachment
// ---------------------------------------------------------------------------

export function sampleMoveIndices(game: GameRecord, color: Color, samples: number): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < game.moves.length; i += 1) {
    if (game.moves[i].color === color && i + 1 > game.book_ply) candidates.push(i);
  }
  if (!candidates.length) return [];
  if (samples <= 0 || candidates.length <= samples) return candidates;
  if (samples === 1) return [candidates[Math.floor(candidates.length / 2)]];
  const picked: number[] = [];
  for (let k = 0; k < samples; k += 1) {
    const index = pyRound((k * (candidates.length - 1)) / (samples - 1));
    picked.push(candidates[index]);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

export async function attachEngineAnalysis(
  game: GameRecord,
  color: Color,
  analyzer: Analyzer,
  samples: number,
  depth: number,
  force = false,
  cancelCheck: (() => boolean) | null = null,
): Promise<number> {
  const indices = sampleMoveIndices(game, color, samples);
  if (!indices.length) return 0;
  let evaluated = 0;
  for (const i of indices) {
    if (cancelCheck && cancelCheck()) break;
    const move = game.moves[i];
    if (!force && move.eval_cp !== null) continue;
    const before = await analyzer.evaluate(move.fen_before);
    if (!before) continue;
    let afterCp: number;
    if (isGameOver(move.fen_after)) {
      afterCp = terminalCp(move.fen_after);
    } else {
      const after = await analyzer.evaluate(move.fen_after);
      if (!after) continue;
      afterCp = after.cp;
    }
    move.eval_before_cp = before.cp;
    move.eval_cp = afterCp;
    move.best_uci = before.best_uci;
    move.best_san = move.best_uci ? uciToSan(move.fen_before, move.best_uci) : null;
    move.is_best = Boolean(move.best_uci && move.uci === move.best_uci);
    move.source = "engine";
    move.judgment = null;
    move.mate = before.mate;
    evaluated += 1;
  }
  if (evaluated) {
    game.analysis_source = "stockfish";
    game.engine_depth = depth;
    computeLosses(game);
  }
  return evaluated;
}

export async function attachEngineTopMatch(
  game: GameRecord,
  color: Color,
  analyzer: Analyzer,
  samples: number,
  depth: number,
  cancelCheck: (() => boolean) | null = null,
): Promise<number> {
  const indices = sampleMoveIndices(game, color, samples);
  if (!indices.length) return 0;
  let matched = 0;
  for (const i of indices) {
    if (cancelCheck && cancelCheck()) break;
    const move = game.moves[i];
    if (move.is_best !== null) continue;
    const before = await analyzer.evaluate(move.fen_before);
    if (!before) continue;
    move.best_uci = before.best_uci;
    move.best_san = move.best_uci ? uciToSan(move.fen_before, move.best_uci) : null;
    move.is_best = Boolean(move.best_uci && move.uci === move.best_uci);
    matched += 1;
  }
  if (matched) game.engine_depth = depth;
  return matched;
}

export async function attachCloudAnalysis(
  game: GameRecord,
  color: Color,
  evaluator: CloudEvaluatorLike,
  samples: number,
  force = false,
): Promise<number> {
  const indices = sampleMoveIndices(game, color, samples);
  if (!indices.length) return 0;
  let evaluated = 0;
  for (const i of indices) {
    const move = game.moves[i];
    if (!force && move.eval_cp !== null) continue;
    const before = await evaluator.evaluate(move.fen_before);
    const beforeCp = payloadCp(before, move.fen_before);
    if (beforeCp === null) continue;
    let afterCp: number;
    if (isGameOver(move.fen_after)) {
      afterCp = terminalCp(move.fen_after);
    } else {
      const after = await evaluator.evaluate(move.fen_after);
      afterCp = payloadCp(after, move.fen_after) as number;
      if (afterCp === null) continue;
    }
    move.eval_before_cp = beforeCp;
    move.eval_cp = afterCp;
    move.best_uci = before && before.best_uci ? String(before.best_uci) : null;
    move.best_san = move.best_uci ? uciToSan(move.fen_before, move.best_uci) : null;
    move.is_best = Boolean(move.best_uci && move.uci === move.best_uci);
    move.source = "cloud";
    move.judgment = null;
    move.mate = before && before.mate !== undefined ? intOrNull(before.mate) : null;
    evaluated += 1;
  }
  if (evaluated) {
    game.analysis_source = "cloud";
    computeLosses(game);
  }
  return evaluated;
}

// ---------------------------------------------------------------------------
// Game-level metrics
// ---------------------------------------------------------------------------

export function gameAccuracy(moves: MoveRecord[], color: Color): number | null {
  const points = new Map<number, number>();
  const accuracies: Array<[number, number]> = [];
  let prevEval: number | null = 0;
  const orderedMoves = [...moves].sort((a, b) => a.ply - b.ply);
  for (const move of orderedMoves) {
    let before = move.eval_before_cp;
    if (before === null) before = move.ply > 1 ? prevEval : 0;
    const after = move.eval_cp;
    if (before !== null && after !== null) {
      points.set(move.ply - 1, winPercentFor(before, color));
      points.set(move.ply, winPercentFor(after, color));
      if (move.color === color && move.accuracy !== null) {
        accuracies.push([move.ply, move.accuracy]);
      }
    }
    prevEval = after !== null ? after : prevEval;
  }
  if (!points.size || !accuracies.length) return null;

  const ordered = [...points.entries()].sort((a, b) => a[0] - b[0]);
  const wps = ordered.map(([, wp]) => wp);
  const index = new Map<number, number>();
  ordered.forEach(([ply], i) => index.set(ply, i));
  let window = Math.trunc(clamp((wps.length - 1) / 10.0, 2, 8));
  window = Math.min(window, wps.length);

  let weightedSum = 0;
  let weightSum = 0;
  const values: number[] = [];
  for (const [ply, accuracy] of accuracies) {
    const i = index.get(ply);
    if (i === undefined) continue;
    const chunk = wps.slice(Math.max(0, i - window + 1), i + 1);
    let sd = 0;
    if (chunk.length >= 2) {
      const mean = fmean(chunk) as number;
      sd = Math.sqrt((fmean(chunk.map((value) => (value - mean) ** 2)) as number) || 0);
    }
    const weight = clamp(sd, 0.5, 12);
    weightedSum += accuracy * weight;
    weightSum += weight;
    values.push(accuracy);
  }
  if (!values.length || !weightSum) return null;
  const weighted = weightedSum / weightSum;
  const harmonic = values.length / values.reduce((sum, value) => sum + 1.0 / Math.max(value, 0.01), 0);
  return (weighted + harmonic) / 2.0;
}

export function gameResultFor(game: GameRecord, color: Color): [string, number] {
  if (game.result === "1/2-1/2" || !game.winner) return ["draw", 0.5];
  return game.winner === color ? ["win", 1.0] : ["loss", 0.0];
}

export function eloDp(scoreRate: number): number {
  const value = clamp(scoreRate, 0.001, 0.999);
  return -400.0 * Math.log10(1.0 / value - 1.0);
}

export function computeGameMetrics(game: GameRecord, color: Color): GameMetrics {
  const playerMoves = game.moves.filter((move) => move.color === color);
  const analyzed = playerMoves.filter((move) => move.loss_cp !== null);
  const nMoves = playerMoves.length;
  const nAnalyzed = analyzed.length;

  const [result, score] = gameResultFor(game, color);
  const playerElo = color === WHITE ? game.white_elo : game.black_elo;
  const oppElo = color === WHITE ? game.black_elo : game.white_elo;
  const oppName = color === WHITE ? game.black : game.white;

  let acpl: number | null = analyzed.length ? fmean(analyzed.map((move) => move.loss_cp as number)) : null;
  const computedAccuracy = gameAccuracy(game.moves, color);
  const provided = (game.player_analysis[color] || {}) as Record<string, any>;
  const fromLichess = game.analysis_source === "lichess";
  let accuracy = fromLichess ? floatOrNull(provided.accuracy) : null;
  if (accuracy === null) accuracy = computedAccuracy;
  const providedAcpl = floatOrNull(provided.acpl);
  if (providedAcpl !== null && fromLichess) acpl = providedAcpl;

  const judgments: Record<string, number> = { inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const move of playerMoves) {
    if (move.judgment && move.judgment in judgments) judgments[move.judgment] += 1;
  }
  if (game.analysis_source === "lichess") {
    for (const key of Object.keys(judgments)) {
      const value = provided[key];
      if (value !== null && value !== undefined) judgments[key] = Math.trunc(Number(value));
    }
  }

  const topValues = analyzed.filter((move) => move.is_best !== null).map((move) => Boolean(move.is_best));
  const topMatch = topValues.length ? topValues.filter(Boolean).length / topValues.length : null;

  const fastThreshold = FAST_THRESHOLDS[game.speed] ?? 3.0;
  const timedAnalyzed = analyzed.filter(
    (move) => move.think_time !== null && (move.legal_count === null || move.legal_count > 3),
  );
  const fast = timedAnalyzed.filter((move) => (move.think_time as number) <= fastThreshold);
  const slow = timedAnalyzed.filter((move) => (move.think_time as number) > fastThreshold);
  const fastAcc = fast.length ? fmean(fast.map((move) => move.accuracy as number)) : null;
  const slowAcc = slow.length ? fmean(slow.map((move) => move.accuracy as number)) : null;
  const fastShare = timedAnalyzed.length ? fast.length / timedAnalyzed.length : null;

  const timedAll = playerMoves.filter((move) => move.think_time !== null);
  const times = timedAll.map((move) => move.think_time as number);
  const medianTime = times.length ? median(times) : null;
  const meanTime = times.length ? fmean(times) : null;
  let timeCv: number | null = null;
  if (times.length >= 8 && meanTime && meanTime > 0) {
    timeCv = pstdev(times) / meanTime;
  }

  let performance: number | null = null;
  if (oppElo !== null) performance = oppElo + eloDp(score);

  const flags: string[] = [];
  if (judgments.blunder === 0 && nAnalyzed >= 20 && accuracy && accuracy >= 92) flags.push("no-blunders");
  if (fastAcc !== null && fastShare !== null && fastShare >= 0.35 && fastAcc >= 88) flags.push("fast-accurate");
  if (performance !== null && playerElo !== null && performance - playerElo >= 200) flags.push("rating-outlier");
  if (medianTime !== null && medianTime <= 2.0 && accuracy && accuracy >= 88) flags.push("low-time-high-accuracy");

  return {
    game_id: game.id,
    url: game.url,
    date: dateFromMs(game.created_at),
    created_at: game.created_at,
    white: game.white,
    black: game.black,
    white_elo: game.white_elo,
    black_elo: game.black_elo,
    color,
    opponent: oppName,
    opponent_rating: oppElo,
    player_rating: playerElo,
    rating_diff: playerElo !== null && oppElo !== null ? playerElo - oppElo : null,
    result: result as GameMetrics["result"],
    score,
    speed: game.speed,
    perf: game.perf,
    time_control: game.time_control,
    opening: game.opening,
    eco: game.eco,
    status: game.status,
    moves_count: nMoves,
    analyzed_moves: nAnalyzed,
    acpl: acpl !== null ? pyRound(acpl, 1) : null,
    accuracy: accuracy !== null ? pyRound(accuracy, 1) : null,
    top_match: topMatch !== null ? pyRound(topMatch, 3) : null,
    top_moves: topValues.length,
    inaccuracies: judgments.inaccuracy,
    mistakes: judgments.mistake,
    blunders: judgments.blunder,
    blunder_rate: nMoves ? pyRound((100.0 * judgments.blunder) / nMoves, 1) : null,
    fast_threshold: fastThreshold,
    fast_moves: fast.length,
    slow_moves: slow.length,
    fast_accuracy: fastAcc !== null ? pyRound(fastAcc, 1) : null,
    slow_accuracy: slowAcc !== null ? pyRound(slowAcc, 1) : null,
    fast_share: fastShare !== null ? pyRound(fastShare, 3) : null,
    median_time: medianTime !== null ? pyRound(medianTime, 2) : null,
    mean_time: meanTime !== null ? pyRound(meanTime, 2) : null,
    time_cv: timeCv !== null ? pyRound(timeCv, 3) : null,
    timed_moves: times.length,
    performance: performance !== null ? pyRound(performance, 0) : null,
    engine_source: game.analysis_source,
    engine_depth: game.engine_depth,
    flags,
    _fast_acc_sum: fastAcc !== null ? fastAcc * fast.length : 0.0,
    _fast_acc_n: fast.length,
    _slow_acc_sum: slowAcc !== null ? slowAcc * slow.length : 0.0,
    _slow_acc_n: slow.length,
  };
}

// ---------------------------------------------------------------------------
// Aggregation and scoring
// ---------------------------------------------------------------------------

function weighted(values: Array<[number | null, number]>): number | null {
  let total = 0;
  let weight = 0;
  for (const [value, w] of values) {
    if (value === null || w <= 0) continue;
    total += value * w;
    weight += w;
  }
  return weight ? total / weight : null;
}

function gFastThreshold(analyzed: GameMetrics[]): number {
  const values = analyzed.map((game) => game.fast_threshold).filter((value): value is number => Boolean(value));
  return values.length ? (fmean(values) as number) : 3.0;
}

export interface AggregateOptions {
  username: string;
  profile: Profile | Record<string, any> | null;
  engineMode: string;
  depth: number;
  samples: number;
  source?: string;
  warnings?: string[];
}

export function aggregateReport(games: GameMetrics[], options: AggregateOptions): Report {
  const warnings = options.warnings || [];
  const analyzed = games.filter((game) => (game.analyzed_moves || 0) > 0);

  const totalMoves = analyzed.reduce((sum, game) => sum + game.analyzed_moves, 0);
  const totalTimed = games.reduce((sum, game) => sum + game.timed_moves, 0);

  const acpl = weighted(analyzed.map((game): [number | null, number] => [game.acpl, game.analyzed_moves]));
  const accuracy = weighted(analyzed.map((game): [number | null, number] => [game.accuracy, game.analyzed_moves]));
  const topMatch = weighted(analyzed.map((game): [number | null, number] => [game.top_match, game.top_moves]));
  const fastAcc = weighted(analyzed.map((game): [number | null, number] => [game.fast_accuracy, game.fast_moves]));
  const slowAcc = weighted(analyzed.map((game): [number | null, number] => [game.slow_accuracy, game.slow_moves]));
  const fastMoves = analyzed.reduce((sum, game) => sum + game.fast_moves, 0);
  const slowMoves = analyzed.reduce((sum, game) => sum + game.slow_moves, 0);
  const timedMoves = games.reduce((sum, game) => sum + game.timed_moves, 0);

  const ratings = games.map((game) => game.player_rating).filter((value): value is number => Boolean(value));
  const avgRating = ratings.length ? (fmean(ratings) as number) : 1500.0;
  const speeds: Record<string, number> = {};
  for (const game of games) speeds[game.speed] = (speeds[game.speed] || 0) + 1;
  let dominantSpeed = "blitz";
  let dominantCount = -1;
  for (const [speed, count] of Object.entries(speeds)) {
    if (count > dominantCount) {
      dominantSpeed = speed;
      dominantCount = count;
    }
  }

  const expAcpl = expectedAcpl(avgRating, dominantSpeed);
  const expAcc = expectedAccuracy(avgRating, dominantSpeed);
  const expTop = expectedTopMatch(avgRating);

  const performances = games.map((game) => game.performance).filter((value): value is number => value !== null);
  const performance = performances.length ? (fmean(performances) as number) : null;

  const blunders = analyzed.reduce((sum, game) => sum + game.blunders, 0);
  const mistakes = analyzed.reduce((sum, game) => sum + game.mistakes, 0);
  const inaccuracies = analyzed.reduce((sum, game) => sum + game.inaccuracies, 0);
  const blunderRate = totalMoves ? (100.0 * blunders) / totalMoves : null;

  const ordered = [...games].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  let streak = 0;
  let current = 0;
  for (const game of ordered) {
    if (game.result === "win") {
      current += 1;
      streak = Math.max(streak, current);
    } else {
      current = 0;
    }
  }

  const engineCoverage = games.length ? analyzed.length / games.length : 0.0;
  const totalMovesAll = games.reduce((sum, game) => sum + game.moves_count, 0);
  const timeCoverage = games.length && totalMovesAll ? timedMoves / totalMovesAll : 0.0;

  const components: ReportComponent[] = [];
  const z: Record<string, number> = {};

  const addComponent = (
    key: string,
    label: string,
    value: number | null,
    expected: number | null,
    zValue: number | null,
    weight: number,
    unit = "",
    available = true,
    detail = "",
  ) => {
    if (!available || zValue === null) return;
    z[key] = zValue;
    components.push({
      key,
      label,
      value: value !== null ? pyRound(value, 2) : null,
      expected: expected !== null ? pyRound(expected, 2) : null,
      z: pyRound(zValue, 2),
      weight,
      unit,
      detail,
    });
  };

  if (acpl !== null && totalMoves >= 20) {
    const sd = Math.max(9.0, expAcpl * 0.26);
    addComponent("acpl", "Average centipawn loss", acpl, expAcpl, clamp((expAcpl - acpl) / sd, -3, 4), 0.95, "cp", true, `${totalMoves} analysed moves`);
  }

  if (accuracy !== null && totalMoves >= 20) {
    addComponent("accuracy", "Average move accuracy", accuracy, expAcc, clamp((accuracy - expAcc) / 5.5, -3, 4), 0.55, "%");
  }

  const topMovesTotal = analyzed.reduce((sum, game) => sum + game.top_moves, 0);
  if (topMatch !== null && topMovesTotal >= 40) {
    addComponent(
      "top_match",
      "Engine top-move agreement",
      topMatch * 100,
      expTop * 100,
      clamp((topMatch - expTop) / 0.1, -3, 4),
      0.4,
      "%",
      true,
      "Local Stockfish / cloud eval",
    );
  }

  if (fastAcc !== null && fastMoves >= 15) {
    let zFast: number;
    let detail: string;
    if (slowMoves >= 8 && slowAcc !== null) {
      const penalty = slowAcc - fastAcc;
      const expectedPenalty = EXPECTED_FAST_PENALTY[dominantSpeed] ?? 4.0;
      zFast = clamp((expectedPenalty - penalty) / 6.5, -2.5, 4);
      detail = `fast ${fastAcc.toFixed(1)}% vs slower ${slowAcc.toFixed(1)}%`;
    } else {
      zFast = clamp((fastAcc - expAcc) / 6.5, -2.5, 4);
      detail = `${fastMoves} moves under ${gFastThreshold(analyzed)}s`;
    }
    addComponent("fast_accuracy", "Accuracy when moving fast", fastAcc, expAcc, zFast, 0.45, "%", true, detail);
  }

  if (performance !== null && games.length >= 8) {
    addComponent(
      "performance",
      "Rating performance vs own rating",
      performance,
      avgRating,
      clamp((performance - avgRating - 40.0) / 110.0, -3, 3),
      0.22,
      "Elo",
    );
  }

  const cvs = analyzed
    .filter((game) => game.time_cv !== null && (game.median_time || 0) >= 2.0)
    .map((game) => game.time_cv as number);
  if (cvs.length >= 8) {
    const cv = fmean(cvs) as number;
    addComponent("time_uniformity", "Uniformity of think times", cv, 0.55, clamp((0.42 - cv) / 0.12, -2, 3), 0.1, "CV", true, "Lower is more machine-like");
  }

  if (games.length >= 15) {
    let p = games.reduce((sum, game) => sum + game.score, 0) / games.length;
    p = clamp(p, 0.05, 0.95);
    const expectedStreak = Math.log(Math.max(games.length, 2)) / Math.max(0.15, Math.log(1.0 / Math.max(1.0 - p, 0.05)));
    addComponent("win_streak", "Longest winning streak", streak, expectedStreak, clamp((streak - expectedStreak) / 2.2, -2, 3), 0.08, "games");
  }

  let rawZ = 0;
  if (components.length) {
    const weightSum = components.reduce((sum, component) => sum + component.weight, 0);
    rawZ = components.reduce((sum, component) => sum + component.z * component.weight, 0) / weightSum;
  }

  const moveConf = clamp(totalMoves / 180.0, 0, 1) ** 0.5;
  const gameConf = clamp(games.length / 20.0, 0, 1) * 0.4 + 0.6;
  const engineConf = 0.55 + 0.45 * clamp(engineCoverage, 0, 1);
  const confidence = clamp(moveConf * gameConf * engineConf, 0.05, 1.0);

  const rawScore = 100.0 / (1.0 + Math.exp(-(rawZ - 1.0) * 1.7));
  let score = 20.0 + (rawScore - 20.0) * (0.65 + 0.35 * confidence);
  score = pyRound(clamp(score, 0, 100));

  let verdict: string;
  if (score < 30) verdict = "Low signal";
  else if (score < 45) verdict = "Mild signal";
  else if (score < 60) verdict = "Some signal";
  else if (score < 75) verdict = "Elevated signal";
  else if (score < 88) verdict = "High signal";
  else verdict = "Very high signal";

  let confidenceLabel: string;
  if (confidence < 0.35) confidenceLabel = "Low";
  else if (confidence < 0.65) confidenceLabel = "Medium";
  else confidenceLabel = "High";

  const reasons = buildReasons({
    components,
    games,
    analyzed,
    totalMoves,
    avgRating,
    dominantSpeed,
    acpl,
    expAcpl,
    accuracy,
    expAcc,
    topMatch,
    expTop,
    fastAcc,
    slowAcc,
    fastMoves,
    performance,
    streak,
    confidence,
  });

  const notes: string[] = [];
  if (engineCoverage < 0.5) {
    notes.push(
      `Only ${Math.round(engineCoverage * 100)}% of games had engine evaluations. Scores are less reliable; add Stockfish or use games with Lichess analysis.`,
    );
  }
  if (timeCoverage < 0.5) {
    notes.push(`Clock data was available for ${Math.round(timeCoverage * 100)}% of moves; time-based signals are limited.`);
  }
  if (options.source === "pgn") {
    notes.push("Imported PGN data. Only games with eval/clock annotations or local engine analysis were scored deeply.");
  }
  if (options.engineMode === "lichess" && options.source !== "demo") {
    notes.push("Engine mode was set to existing Lichess analysis only; unanalysed games contribute mostly heuristics.");
  }

  const profile: any = options.profile || {};
  const perfInfo = ((profile.perfs || {})[dominantSpeed] || {}) as Record<string, any>;
  if (perfInfo.prov) {
    notes.push(
      `The ${dominantSpeed} rating is provisional (${Math.trunc(Number(perfInfo.games || 0))} games), so rating-based baselines are less reliable.`,
    );
  } else if (perfInfo.prog !== null && perfInfo.prog !== undefined && Math.abs(Math.trunc(Number(perfInfo.prog))) >= 50) {
    const prog = Math.trunc(Number(perfInfo.prog));
    notes.push(
      `The ${dominantSpeed} rating moved ${prog >= 0 ? "+" : ""}${prog} points recently; the current rating may not reflect the games in this sample.`,
    );
  }

  const analysisSources: Record<string, number> = {};
  for (const game of games) {
    const key = game.engine_source || "none";
    analysisSources[key] = (analysisSources[key] || 0) + 1;
  }

  const dateValues = games.map((game) => game.date).filter((value): value is string => Boolean(value));
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

  return {
    meta: {
      username: options.username,
      source: options.source || "lichess",
      generated_at: generatedAt,
      engine_mode: options.engineMode,
      engine_depth: options.depth,
      samples_per_game: options.samples,
      analysis_sources: analysisSources,
      games_total: games.length,
      games_analyzed: analyzed.length,
      moves_analyzed: totalMoves,
      timed_moves: timedMoves,
      engine_coverage: pyRound(engineCoverage, 3),
      time_coverage: pyRound(timeCoverage, 3),
      speeds,
      avg_rating: pyRound(avgRating, 0),
      date_min: dateValues.length ? dateValues.reduce((a, b) => (a < b ? a : b)) : null,
      date_max: dateValues.length ? dateValues.reduce((a, b) => (a > b ? a : b)) : null,
      warnings,
      disclaimer:
        "Statistical screening only. These numbers are not proof of cheating, and strong or fast players can produce outlier scores. Always review the underlying games and context before drawing conclusions.",
    },
    profile: options.profile || {},
    summary: {
      score,
      verdict,
      confidence: pyRound(confidence, 2),
      confidence_label: confidenceLabel,
      raw_z: pyRound(rawZ, 2),
      metrics: {
        games: games.length,
        games_analyzed: analyzed.length,
        analyzed_moves: totalMoves,
        avg_rating: pyRound(avgRating, 0),
        acpl: acpl !== null ? pyRound(acpl, 1) : null,
        expected_acpl: pyRound(expAcpl, 1),
        accuracy: accuracy !== null ? pyRound(accuracy, 1) : null,
        expected_accuracy: pyRound(expAcc, 1),
        top_match: topMatch !== null ? pyRound(topMatch * 100, 1) : null,
        expected_top_match: pyRound(expTop * 100, 1),
        fast_accuracy: fastAcc !== null ? pyRound(fastAcc, 1) : null,
        slow_accuracy: slowAcc !== null ? pyRound(slowAcc, 1) : null,
        fast_moves: fastMoves,
        slow_moves: slowMoves,
        blunders,
        mistakes,
        inaccuracies,
        blunder_rate: blunderRate !== null ? pyRound(blunderRate, 1) : null,
        performance: performance !== null ? pyRound(performance, 0) : null,
        win_streak: streak,
        dominant_speed: dominantSpeed,
      },
      components: [...components].sort((a, b) => b.weight * b.z - a.weight * a.z),
      reasons,
      notes,
    },
    games,
  };
}

interface ReasonOptions {
  components: ReportComponent[];
  games: GameMetrics[];
  analyzed: GameMetrics[];
  totalMoves: number;
  avgRating: number;
  dominantSpeed: string;
  acpl: number | null;
  expAcpl: number;
  accuracy: number | null;
  expAcc: number;
  topMatch: number | null;
  expTop: number;
  fastAcc: number | null;
  slowAcc: number | null;
  fastMoves: number;
  performance: number | null;
  streak: number;
  confidence: number;
}

function buildReasons(options: ReasonOptions): ReportReason[] {
  const reasons: ReportReason[] = [];
  const byKey: Record<string, ReportComponent> = {};
  for (const component of options.components) byKey[component.key] = component;

  if (byKey.acpl && byKey.acpl.z >= 0.9) {
    reasons.push({
      severity: byKey.acpl.z >= 1.8 ? "high" : "medium",
      title: "Low average centipawn loss",
      detail:
        `${(options.acpl as number).toFixed(1)} cp across ${options.totalMoves} analysed moves, versus ` +
        `~${options.expAcpl.toFixed(0)} cp expected for ${options.avgRating.toFixed(0)} ${options.dominantSpeed}. ` +
        "Lower loss means the player's moves stayed closer to the engine's top choices.",
    });
  }

  if (byKey.accuracy && byKey.accuracy.z >= 0.9) {
    reasons.push({
      severity: byKey.accuracy.z >= 1.8 ? "high" : "medium",
      title: "Accuracy above the rating baseline",
      detail:
        `${(options.accuracy as number).toFixed(1)}% average accuracy versus ~${options.expAcc.toFixed(1)}% expected. ` +
        "Accuracy is derived from the win-probability drop of each move.",
    });
  }

  if (byKey.top_match && byKey.top_match.z >= 0.9 && options.topMatch !== null) {
    reasons.push({
      severity: byKey.top_match.z >= 1.8 ? "high" : "medium",
      title: "Frequent engine top-move agreement",
      detail:
        `${(options.topMatch * 100).toFixed(1)}% of sampled moves matched the engine's first choice, ` +
        `versus ~${(options.expTop * 100).toFixed(1)}% expected. This is one of the strongest single signals.`,
    });
  }

  if (byKey.fast_accuracy && byKey.fast_accuracy.z >= 0.9 && options.fastAcc !== null) {
    let detail: string;
    if (options.slowAcc !== null && options.fastMoves >= 8) {
      detail =
        `Accuracy was ${options.fastAcc.toFixed(1)}% on fast moves and ${options.slowAcc.toFixed(1)}% on slower moves. ` +
        "Fast moves often come in familiar or simpler positions, so this is supporting context rather than proof of assistance.";
    } else {
      detail = `${options.fastMoves} moves were played quickly and still averaged ${options.fastAcc.toFixed(1)}% accuracy.`;
    }
    reasons.push({
      severity: byKey.fast_accuracy.z >= 2.5 ? "high" : "medium",
      title: "High accuracy with little thinking time",
      detail,
    });
  }

  if (byKey.performance && byKey.performance.z >= 1.0 && options.performance !== null) {
    reasons.push({
      severity: "medium",
      title: "Performance far above rating",
      detail:
        `Elo performance of ${options.performance.toFixed(0)} against an average rating of ` +
        `${options.avgRating.toFixed(0)} (+${(options.performance - options.avgRating).toFixed(0)}). A short sample can produce this by chance.`,
    });
  }

  if (byKey.time_uniformity && byKey.time_uniformity.z >= 1.0) {
    reasons.push({
      severity: "medium",
      title: "Unusually uniform think times",
      detail:
        "Think-time variation is lower than typical human play. Some players are simply " +
        "consistent, so treat this as supporting context rather than a standalone flag.",
    });
  }

  if (byKey.win_streak && byKey.win_streak.z >= 1.2) {
    reasons.push({
      severity: "low",
      title: "Long winning streak",
      detail: `Longest streak in the sample: ${options.streak} wins. Streaks are noisy and weak evidence on their own.`,
    });
  }

  if (!reasons.length) {
    reasons.push({
      severity: "info",
      title: "No strong statistical outliers",
      detail:
        "Accuracy, centipawn loss, time usage and results are all broadly in line with " +
        "the player's rating and time control. This does not prove fair play; it simply " +
        "means this screen found no large anomalies.",
    });
  }

  if (options.confidence < 0.35) {
    reasons.push({
      severity: "info",
      title: "Small or incomplete sample",
      detail: "Treat this report as a rough screen. More games and full engine coverage would make it much more reliable.",
    });
  }
  return reasons;
}

export function scoreSingleGame(metrics: GameMetrics, speed: string, rating: number): number {
  const zs: Array<[number, number]> = [];
  if (metrics.acpl !== null && (metrics.analyzed_moves || 0) >= 10) {
    const exp = expectedAcpl(rating, speed);
    zs.push([clamp((exp - metrics.acpl) / Math.max(9.0, exp * 0.26), -3, 4), 0.95]);
  }
  if (metrics.accuracy !== null && (metrics.analyzed_moves || 0) >= 10) {
    const exp = expectedAccuracy(rating, speed);
    zs.push([clamp((metrics.accuracy - exp) / 5.5, -3, 4), 0.55]);
  }
  if (metrics.top_match !== null && (metrics.top_moves || 0) >= 15) {
    const exp = expectedTopMatch(rating);
    zs.push([clamp((metrics.top_match - exp) / 0.1, -3, 4), 0.4]);
  }
  if (metrics.fast_accuracy !== null && (metrics.fast_moves || 0) >= 8) {
    const exp = expectedAccuracy(rating, speed);
    zs.push([clamp((metrics.fast_accuracy - exp) / 5.5, -3, 4), 0.6]);
  }
  if (!zs.length) return 25;
  const weightSum = zs.reduce((sum, [, weight]) => sum + weight, 0);
  const rawZ = zs.reduce((sum, [value, weight]) => sum + value * weight, 0) / weightSum;
  const raw = 100.0 / (1.0 + Math.exp(-(rawZ - 1.0) * 1.7));
  const shrink = clamp(((metrics.analyzed_moves || 0) / 40.0) ** 0.5, 0.3, 1.0);
  return pyRound(clamp(20.0 + (raw - 20.0) * shrink, 0, 100));
}

export function finalizeGames(games: GameMetrics[]): GameMetrics[] {
  for (const game of games) {
    const rating = game.player_rating || 1500;
    game.suspicion = scoreSingleGame(game, game.speed || "blitz", rating);
    game.flags = [...new Set(game.flags || [])].sort();
    delete (game as any)._fast_acc_sum;
    delete (game as any)._fast_acc_n;
    delete (game as any)._slow_acc_sum;
    delete (game as any)._slow_acc_n;
  }
  games.sort((a, b) => {
    const sa = a.suspicion || 0;
    const sb = b.suspicion || 0;
    if (sa !== sb) return sb - sa;
    const aa = a.acpl || 9999;
    const ab = b.acpl || 9999;
    return ab - aa;
  });
  return games;
}

export function trimReportDetails(report: Report, maxDetailGames = 250): void {
  const games = report.games || [];
  if (games.length <= maxDetailGames) return;
  const keep = new Set(games.slice(0, maxDetailGames).map((game) => game.game_id));
  for (const game of games) {
    if (!keep.has(game.game_id)) {
      game.moves = [];
      game.detail_available = false;
    }
  }
}

export function buildMetricsWithMoves(game: GameRecord, color: Color): GameMetrics {
  const metrics = computeGameMetrics(game, color);
  metrics.moves = game.moves.map(moveAsDict);
  metrics.detail_available = true;
  return metrics;
}
