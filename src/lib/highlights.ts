import type { GameMetrics, Report } from "./types";

/**
 * Structural subset of the trimmed move dictionary written by `moveAsDict`.
 * Kept in lib so both the UI and the HTML exporter can rank moments without
 * depending on DOM code.
 */
export interface HighlightMove {
  ply: number;
  move_no: number;
  color: "white" | "black";
  san: string;
  loss_cp: number | null;
  think_time: number | null;
  accuracy: number | null;
  eval_cp: number | null;
  is_best: boolean | null;
  best_san: string | null;
  judgment: string | null;
}

export interface CriticalMoment {
  game: GameMetrics;
  move: HighlightMove;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Evaluation before the move, from White's point of view. */
export function evalBefore(move: HighlightMove): number | null {
  if (move.eval_cp === null || move.eval_cp === undefined) return null;
  if (move.loss_cp === null || move.loss_cp === undefined) return null;
  const sign = move.color === "white" ? 1 : -1;
  return move.eval_cp + sign * move.loss_cp;
}

/** 1 = dead equal (hard), 0 = decisive (easy). */
export function tensionOf(move: HighlightMove): number {
  const before = evalBefore(move);
  if (before === null) return 0.5;
  return clamp(1 - Math.abs(before) / 600, 0.05, 1);
}

function movesOf(game: GameMetrics): HighlightMove[] {
  return (game.moves || []) as unknown as HighlightMove[];
}

export function criticalErrors(report: Report, limit = 8): CriticalMoment[] {
  const items: CriticalMoment[] = [];
  for (const game of report.games || []) {
    if (game.detail_available === false) continue;
    for (const move of movesOf(game)) {
      if (move.color !== game.color) continue;
      const loss = move.loss_cp ?? 0;
      if (loss < 40) continue;
      items.push({ game, move, score: loss * (0.55 + 0.45 * tensionOf(move)) });
    }
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

export function criticalFinds(report: Report, limit = 8): CriticalMoment[] {
  const items: CriticalMoment[] = [];
  for (const game of report.games || []) {
    if (game.detail_available === false) continue;
    for (const move of movesOf(game)) {
      if (move.color !== game.color) continue;
      if (move.is_best !== true) continue;
      const hasClock = move.think_time !== null && move.think_time !== undefined;
      const speed = hasClock ? 1 / ((move.think_time as number) + 0.75) : 0.15;
      items.push({ game, move, score: speed * (0.4 + 0.6 * tensionOf(move)) * 100 });
    }
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}
