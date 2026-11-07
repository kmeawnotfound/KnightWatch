import type { GameMetrics } from "../lib/types";
import { renderBoard } from "./board";
import { drawEvalChart } from "./chart";
import { byId, clearNode, el, setText } from "./dom";
import { fmtInt, fmtNumber, fmtPawns, fmtPct, fmtTime, titleCase } from "./format";
import { state } from "./state";
import { gameMoves, moveNumber, type MoveView } from "./view-types";

export function openGame(game: GameMetrics, ply?: number): void {
  if (!game) return;
  state.selectedGame = game;
  const moves = gameMoves(game);
  if (typeof ply === "number") {
    const index = moves.findIndex((move) => move.ply === ply);
    state.boardIndex = index >= 0 ? index + 1 : moves.length;
  } else {
    state.boardIndex = moves.length;
  }

  setText(byId("modal-kicker"), `Game review · signal ${game.suspicion ?? "—"}/100`);
  setText(byId("modal-title"), `${game.white || "White"} vs ${game.black || "Black"}`);
  setText(
    byId("modal-subtitle"),
    `${game.date || "unknown date"} · ${titleCase(game.speed)} · ${game.time_control || ""} · ${game.opening || ""}`,
  );

  const link = byId<HTMLAnchorElement>("modal-link");
  if (game.url) {
    link.href = game.url;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }

  const metrics = byId("modal-metrics");
  clearNode(metrics);
  const items: Array<[string, string]> = [
    ["Signal", `${game.suspicion ?? "—"}/100`],
    ["ACPL", game.acpl === null || game.acpl === undefined ? "—" : fmtNumber(game.acpl, 1)],
    ["Accuracy", fmtPct(game.accuracy, 1)],
    [
      "Top match",
      game.top_match === null || game.top_match === undefined ? "—" : fmtPct(game.top_match * 100, 1),
    ],
    [
      "Fast acc.",
      game.fast_accuracy === null || game.fast_accuracy === undefined
        ? "—"
        : fmtPct(game.fast_accuracy, 1),
    ],
    ["Blunders", fmtInt(game.blunders)],
  ];
  items.forEach(([label, value]) => {
    const node = el("div", "modal-metric");
    node.appendChild(el("span", null, label));
    node.appendChild(el("strong", null, value));
    metrics.appendChild(node);
  });

  drawEvalChart(byId<SVGSVGElement>("eval-chart"), game);
  renderMoves(game);
  setBoardIndex(state.boardIndex);

  byId("game-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  window.setTimeout(() => byId("modal-close").focus(), 40);
}

export function closeModal(): void {
  byId("game-modal").classList.add("hidden");
  document.body.style.overflow = "";
  state.selectedGame = null;
}

export function toggleBoardFlip(): void {
  state.boardFlipped = !state.boardFlipped;
  setBoardIndex(state.boardIndex);
}

export function setBoardIndex(index: number): void {
  const game = state.selectedGame;
  if (!game) return;
  const moves = gameMoves(game);
  state.boardIndex = Math.max(0, Math.min(index, moves.length));
  renderBoard(
    byId("board"),
    byId<SVGSVGElement>("board-arrows"),
    game,
    state.boardIndex,
    state.boardFlipped,
  );
  updateBoardInfo(moves);
  highlightMove();
}

function updateBoardInfo(moves: MoveView[]): void {
  const index = state.boardIndex;
  const label = byId("board-move");
  const evalNode = byId("board-eval");
  if (index === 0) {
    label.textContent = "Start position";
  } else {
    const move = moves[index - 1];
    label.textContent = `${moveNumber(move)}${move.color === "white" ? "." : "..."} ${move.san}`;
  }
  const last = index > 0 ? moves[index - 1] : null;
  const bits: string[] = [];
  if (last && last.eval_cp !== null && last.eval_cp !== undefined) {
    bits.push(`eval ${fmtPawns(last.eval_cp)}`);
  }
  if (last && last.think_time !== null && last.think_time !== undefined) {
    bits.push(fmtTime(last.think_time));
  }
  if (last?.judgment) bits.push(last.judgment);
  if (last?.best_san && last.best_san !== last.san) bits.push(`best ${last.best_san}`);
  evalNode.textContent = bits.join(" · ");
}

function highlightMove(): void {
  const cells = Array.from(document.querySelectorAll<HTMLElement>("#moves-wrap .move"));
  const target = String(state.boardIndex - 1);
  cells.forEach((cell) => {
    const active = cell.dataset.index === target;
    cell.classList.toggle("active", active);
    if (active) cell.scrollIntoView({ block: "nearest" });
  });
}

interface MoveSlot {
  move: MoveView;
  index: number;
}

function renderMoves(game: GameMetrics): void {
  const wrap = byId("moves-wrap");
  clearNode(wrap);
  const moves = gameMoves(game);
  if (!moves.length) {
    const message =
      game.detail_available === false
        ? "Move detail is only kept for the top games in very large scans."
        : "No move data available for this game.";
    wrap.appendChild(el("div", "moves-empty", message));
    return;
  }

  const header = el("div", "moves-header");
  header.appendChild(el("span", null, "#"));
  header.appendChild(el("span", null, "White"));
  header.appendChild(el("span", null, "Black"));
  wrap.appendChild(header);

  const byNumber = new Map<number, { white?: MoveSlot; black?: MoveSlot }>();
  moves.forEach((move, index) => {
    const number = moveNumber(move);
    if (!byNumber.has(number)) byNumber.set(number, {});
    const slot = byNumber.get(number)!;
    slot[move.color] = { move, index };
  });

  Array.from(byNumber.keys())
    .sort((a, b) => a - b)
    .forEach((number) => {
      const pair = byNumber.get(number)!;
      const row = el("div", "move-row");
      row.appendChild(el("div", "move-no", `${number}.`));
      row.appendChild(buildMoveCell(pair.white, game));
      row.appendChild(buildMoveCell(pair.black, game));
      wrap.appendChild(row);
    });
}

function buildMoveCell(slot: MoveSlot | undefined, game: GameMetrics): HTMLElement {
  const cell = el("div", "move");
  if (!slot) return cell;
  const { move, index } = slot;
  cell.dataset.index = String(index);
  cell.tabIndex = 0;
  cell.setAttribute("role", "button");

  const fastThreshold = game.fast_threshold || 3;
  const fastAccurate =
    move.think_time !== null &&
    move.think_time !== undefined &&
    move.think_time <= fastThreshold &&
    move.accuracy !== null &&
    move.accuracy !== undefined &&
    move.accuracy >= 90;
  if (fastAccurate) cell.classList.add("fast-accurate");

  cell.appendChild(el("span", "san", move.san));
  const metaBits: string[] = [];
  if (move.eval_cp !== null && move.eval_cp !== undefined) metaBits.push(fmtPawns(move.eval_cp));
  if (move.think_time !== null && move.think_time !== undefined) {
    metaBits.push(fmtTime(move.think_time));
  }
  if (metaBits.length) cell.appendChild(el("span", "meta", metaBits.join(" · ")));

  if (move.judgment) {
    cell.appendChild(el("span", `badge ${move.judgment}`, move.judgment));
  }
  if (move.best_san && move.best_san !== move.san && move.judgment) {
    cell.appendChild(el("span", "best", `best ${move.best_san}`));
  }

  cell.addEventListener("click", () => setBoardIndex(index + 1));
  cell.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setBoardIndex(index + 1);
    }
  });
  return cell;
}
