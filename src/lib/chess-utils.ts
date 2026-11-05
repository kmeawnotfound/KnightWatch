import { Chess } from "chess.js";

import type { Color, MoveRecord } from "./types";

export const WHITE: Color = "white";
export const BLACK: Color = "black";

const EVAL_RE = /\[%eval\s+([#-]?\d+(?:\.\d+)?)\]/;
const CLK_RE = /\[%clk\s+(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\]/;
const BEST_RE = /(?:Inaccuracy|Mistake|Blunder)\.\s+([^\s]+)\s+was best\./i;

export const JUDGMENT_ORDER: Record<string, number> = {
  inaccuracy: 1,
  mistake: 2,
  blunder: 3,
};

export const NAG_JUDGMENT: Record<number, string> = {
  2: "mistake",
  3: "blunder",
  4: "inaccuracy",
  6: "inaccuracy",
};

export function normalizeName(name: string | null | undefined): string {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Python's round() uses banker's rounding; this matches it for our ranges. */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (Math.abs(diff - 0.5) < 1e-9) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

export function fmean(values: Iterable<number>): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    sum += value;
    count += 1;
  }
  return count ? sum / count : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid];
  return (ordered[mid - 1] + ordered[mid]) / 2;
}

export function pstdev(values: number[]): number {
  if (!values.length) return 0;
  const mean = fmean(values) as number;
  let sum = 0;
  for (const value of values) sum += (value - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

export function interpolate(anchors: Array<[number, number]>, x: number): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x0 <= x && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return anchors[anchors.length - 1][1];
}

export function mateToCp(mate: number, sideToMove: Color): number {
  if (mate === 0) return sideToMove === WHITE ? -10000 : 10000;
  const magnitude = Math.max(100, 10000 - Math.min(Math.abs(mate), 50) * 100);
  return mate > 0 ? magnitude : -magnitude;
}

export function sideToMove(fen: string): Color {
  try {
    return fen.split(" ")[1] === "w" ? WHITE : BLACK;
  } catch {
    return WHITE;
  }
}

export function terminalCp(fenAfter: string): number {
  try {
    const board = new Chess(fenAfter);
    if (board.isCheckmate()) {
      return board.turn() === "w" ? -10000 : 10000;
    }
  } catch {
    /* invalid FEN */
  }
  return 0;
}

export function isGameOver(fen: string): boolean {
  try {
    return new Chess(fen).isGameOver();
  } catch {
    return false;
  }
}

export function evalEntryCp(entry: Record<string, any>, fenAfter: string): number | null {
  if (entry.eval !== null && entry.eval !== undefined) {
    const value = Number(entry.eval);
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (entry.mate !== null && entry.mate !== undefined) {
    const value = Number(entry.mate);
    return Number.isFinite(value) ? mateToCp(value, sideToMove(fenAfter)) : null;
  }
  return null;
}

export function payloadCp(payload: Record<string, any> | null | undefined, fen: string): number | null {
  if (!payload) return null;
  if (payload.cp !== null && payload.cp !== undefined) {
    const value = Number(payload.cp);
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (payload.mate !== null && payload.mate !== undefined) {
    const value = Number(payload.mate);
    return Number.isFinite(value) ? mateToCp(value, sideToMove(fen)) : null;
  }
  return null;
}

export function winPercentWhite(cp: number): number {
  const value = clamp(Number(cp), -10000, 10000);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * value)) - 1);
}

export function winPercentFor(cp: number, color: Color): number {
  const wp = winPercentWhite(cp);
  return color === WHITE ? wp : 100 - wp;
}

export function accuracyFromDrop(drop: number): number {
  const value = Math.max(0, Number(drop));
  return clamp(103.1668 * Math.exp(-0.04354 * value) - 3.1669 + 1.0, 0, 100);
}

export function judgmentFromDrop(drop: number): string | null {
  if (drop >= 30) return "blunder";
  if (drop >= 20) return "mistake";
  if (drop >= 10) return "inaccuracy";
  return null;
}

export function parseClock(value: string): number | null {
  const match = CLK_RE.exec(value || "");
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseEval(value: string): [number | null, number | null] {
  const match = EVAL_RE.exec(value || "");
  if (!match) return [null, null];
  const raw = match[1];
  if (raw.startsWith("#")) {
    const mate = Number.parseInt(raw.slice(1), 10);
    return [null, Number.isFinite(mate) ? mate : null];
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return [null, null];
  return [pyRound(parsed * 100), null];
}

export function extractBestSan(comment: string): string | null {
  const match = BEST_RE.exec(comment || "");
  return match ? match[1].replace(/[.,;]+$/, "") : null;
}

export function speedFromTimeControl(tc: string, hasClocks: boolean): string {
  if (!tc || tc === "-") return hasClocks ? "classical" : "correspondence";
  let initial: number;
  try {
    initial = Number.parseInt(tc.split("+")[0], 10);
    if (!Number.isFinite(initial)) return "classical";
  } catch {
    return "classical";
  }
  if (initial <= 30) return "ultraBullet";
  if (initial < 180) return "bullet";
  if (initial < 600) return "blitz";
  if (initial < 1800) return "rapid";
  return "classical";
}

function formatG(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const text = value.toPrecision(6);
  if (text.includes("e") || text.includes("E")) return text;
  return text.replace(/\.?0+$/, "");
}

export function timeControlLabel(speed: string, initial: number | null, increment: number | null): string {
  if (initial === null || initial === undefined) return speed;
  const inc = Math.trunc(increment || 0);
  return `${formatG(initial / 60)}+${inc} ${speed}`;
}

export function dateFromMs(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function parseDateHeader(value: string): number | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec((value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(stamp) ? stamp : null;
}

export function sanToUci(fen: string, san: string): string | null {
  try {
    const board = new Chess(fen);
    const move = board.move(san);
    return `${move.from}${move.to}${move.promotion || ""}`;
  } catch {
    return null;
  }
}

export function uciToSan(fen: string, uci: string): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const board = new Chess(fen);
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move.san;
  } catch {
    return null;
  }
}

export function uciFromMove(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

export function moveAsDict(move: MoveRecord): Record<string, any> {
  return {
    ply: move.ply,
    move_no: Math.floor((move.ply + 1) / 2),
    color: move.color,
    san: move.san,
    uci: move.uci,
    clock: move.clock !== null ? pyRound(move.clock, 2) : null,
    think_time: move.think_time !== null ? pyRound(move.think_time, 2) : null,
    eval_cp: move.eval_cp,
    loss_cp: move.loss_cp !== null ? pyRound(move.loss_cp, 1) : null,
    accuracy: move.accuracy !== null ? pyRound(move.accuracy, 1) : null,
    win_drop: move.win_drop !== null ? pyRound(move.win_drop, 1) : null,
    judgment: move.judgment,
    best_uci: move.best_uci,
    best_san: move.best_san,
    is_best: move.is_best,
    source: move.source,
  };
}

export function emptyMove(
  ply: number,
  color: Color,
  san: string,
  uci: string,
  fenBefore: string,
  fenAfter: string,
  legalCount: number | null,
  clock: number | null,
): MoveRecord {
  return {
    ply,
    color,
    san,
    uci,
    fen_before: fenBefore,
    fen_after: fenAfter,
    legal_count: legalCount,
    clock,
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
  };
}
