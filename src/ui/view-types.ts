import type { Color, GameMetrics } from "../lib/types";

/**
 * The report stores a trimmed move dictionary rather than the full MoveRecord.
 * These are the fields that survive `moveAsDict` in src/lib/chess-utils.ts.
 */
export interface MoveView {
  ply: number;
  move_no: number;
  color: Color;
  san: string;
  uci: string;
  clock: number | null;
  think_time: number | null;
  eval_cp: number | null;
  loss_cp: number | null;
  accuracy: number | null;
  win_drop: number | null;
  judgment: string | null;
  best_uci: string | null;
  best_san: string | null;
  is_best: boolean | null;
  source: string | null;
}

export type SortDir = "asc" | "desc";

export interface Filters {
  result: string;
  color: string;
  speed: string;
}

export function gameMoves(game: GameMetrics | null | undefined): MoveView[] {
  return (game?.moves || []) as unknown as MoveView[];
}

export function moveNumber(move: MoveView): number {
  return move.move_no || Math.ceil(move.ply / 2);
}

export { evalBefore, tensionOf } from "../lib/highlights.js";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
