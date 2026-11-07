import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";

import type { GameMetrics } from "../lib/types";
import { byId, clearNode, el } from "./dom";
import { gameMoves, type MoveView } from "./view-types";

const NS = "http://www.w3.org/2000/svg";

const GLYPHS: Record<string, string> = {
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

export type BoardMoveResult = "matched" | "variation";

type BoardCallback = (result: BoardMoveResult) => void;

interface VariationMove {
  san: string;
  from: Square;
  to: Square;
}

interface LegalTarget {
  promotion: PieceSymbol | null;
  capture: boolean;
}

interface BoardState {
  game: GameMetrics | null;
  moves: MoveView[];
  index: number;
  chess: Chess;
  flipped: boolean;
  selected: Square | null;
  legal: Map<string, LegalTarget>;
  lastFrom: string | null;
  lastTo: string | null;
  variation: VariationMove[];
  onChange: BoardCallback | null;
}

interface DragState {
  from: Square;
  startX: number;
  startY: number;
  moved: boolean;
  wasSelected: boolean;
  piece: HTMLElement | null;
  drop: Square | null;
}

const st: BoardState = {
  game: null,
  moves: [],
  index: 0,
  chess: new Chess(),
  flipped: false,
  selected: null,
  legal: new Map(),
  lastFrom: null,
  lastTo: null,
  variation: [],
  onChange: null,
};

let boardEl: HTMLElement | null = null;
let arrowsEl: SVGSVGElement | null = null;
let pickerEl: HTMLElement | null = null;
let drag: DragState | null = null;
let pendingPromotion: { from: Square; to: Square } | null = null;
let bound = false;

/** Replay UCI moves from the standard starting position. */
function replay(moves: MoveView[], count: number): Chess | null {
  const chess = new Chess();
  const limit = Math.max(0, Math.min(count, moves.length));
  for (let i = 0; i < limit; i += 1) {
    const uci = moves[i].uci;
    if (!uci || uci.length < 4) return null;
    try {
      chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined,
      });
    } catch {
      return null;
    }
  }
  return chess;
}

function squareCenter(square: string, flipped: boolean): [number, number] {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  let x = file + 0.5;
  let y = 7.5 - rank;
  if (flipped) {
    x = 8 - x;
    y = 8 - y;
  }
  return [x, y];
}

function drawArrow(
  svg: SVGSVGElement,
  from: string,
  to: string,
  color: string,
  flipped: boolean,
): void {
  const [fx, fy] = squareCenter(from, flipped);
  const [tx, ty] = squareCenter(to, flipped);
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;

  const ux = dx / len;
  const uy = dy / len;
  const startX = fx + ux * 0.3;
  const startY = fy + uy * 0.3;
  const tipX = tx - ux * 0.14;
  const tipY = ty - uy * 0.14;
  const baseX = tipX - ux * 0.36;
  const baseY = tipY - uy * 0.36;
  const px = -uy;
  const py = ux;

  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(startX));
  line.setAttribute("y1", String(startY));
  line.setAttribute("x2", String(baseX));
  line.setAttribute("y2", String(baseY));
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "0.16");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.92");
  svg.appendChild(line);

  const head = document.createElementNS(NS, "polygon");
  const w = 0.26;
  head.setAttribute(
    "points",
    [
      `${tipX},${tipY}`,
      `${baseX + px * w},${baseY + py * w}`,
      `${baseX - px * w},${baseY - py * w}`,
    ].join(" "),
  );
  head.setAttribute("fill", color);
  head.setAttribute("opacity", "0.92");
  svg.appendChild(head);
}

function kingSquare(chess: Chess): Square | null {
  const turn = chess.turn();
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === turn) return cell.square;
    }
  }
  return null;
}

function squareAtPoint(x: number, y: number): Square | null {
  const element = document.elementFromPoint(x, y);
  const cell = element?.closest<HTMLElement>(".board-square");
  const square = cell?.dataset.square;
  return square ? (square as Square) : null;
}

function render(): void {
  if (!boardEl || !arrowsEl) return;
  const chess = st.chess;
  const board = chess.board();
  const checkSquare = chess.isCheck() ? kingSquare(chess) : null;

  clearNode(boardEl);
  clearNode(arrowsEl);

  const rowOrder = [0, 1, 2, 3, 4, 5, 6, 7];
  const colOrder = [0, 1, 2, 3, 4, 5, 6, 7];
  if (st.flipped) {
    rowOrder.reverse();
    colOrder.reverse();
  }

  for (const r of rowOrder) {
    for (const c of colOrder) {
      const piece = board[r][c];
      const square = `${FILES[c]}${8 - r}` as Square;
      const dark = (r + c) % 2 === 1;
      const cell = el("div", `board-square ${dark ? "dark" : "light"}`);
      cell.dataset.square = square;
      if (square === st.lastFrom) cell.classList.add("from");
      if (square === st.lastTo) cell.classList.add("to");
      if (st.selected === square) cell.classList.add("selected");
      if (checkSquare === square) cell.classList.add("check");

      const target = st.legal.get(square);
      if (target) {
        cell.classList.add("legal");
        if (target.capture) cell.classList.add("capture");
      }

      cell.setAttribute(
        "aria-label",
        `${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`,
      );

      if (piece) {
        const pieceEl = el(
          "span",
          `board-piece ${piece.color === "w" ? "white" : "black"}`,
          GLYPHS[piece.type] || "",
        );
        pieceEl.dataset.piece = piece.type;
        cell.appendChild(pieceEl);
      }

      const displayRow = rowOrder.indexOf(r);
      const displayCol = colOrder.indexOf(c);
      if (displayRow === 7) cell.appendChild(el("span", "board-coord file", FILES[c]));
      if (displayCol === 0) cell.appendChild(el("span", "board-coord rank", String(8 - r)));

      boardEl.appendChild(cell);
    }
  }

  if (st.lastFrom && st.lastTo) {
    drawArrow(arrowsEl, st.lastFrom, st.lastTo, "#f0c674", st.flipped);
    const lastGame = !st.variation.length && st.index > 0 ? st.moves[st.index - 1] : null;
    if (
      lastGame?.best_uci &&
      lastGame.best_uci.length >= 4 &&
      lastGame.best_uci !== lastGame.uci
    ) {
      drawArrow(
        arrowsEl,
        lastGame.best_uci.slice(0, 2),
        lastGame.best_uci.slice(2, 4),
        "#4fd1c5",
        st.flipped,
      );
    }
  }
}

function notify(result: BoardMoveResult): void {
  st.onChange?.(result);
}

function clearSelection(): void {
  st.selected = null;
  st.legal.clear();
  render();
}

function select(square: Square): void {
  const piece = st.chess.get(square);
  if (!piece || piece.color !== st.chess.turn()) {
    clearSelection();
    return;
  }
  st.selected = square;
  st.legal.clear();
  const moves = st.chess.moves({ square, verbose: true });
  for (const move of moves) {
    const capture = Boolean(move.captured) || move.flags.includes("e");
    const existing = st.legal.get(move.to);
    if (!existing) {
      st.legal.set(move.to, { promotion: move.promotion ?? null, capture });
    } else if (move.promotion) {
      existing.promotion = move.promotion;
    }
  }
  render();
}

function hidePromotion(): void {
  pickerEl?.classList.add("hidden");
}

function showPromotion(square: Square): void {
  if (!pickerEl) return;
  const color = st.chess.turn();
  pickerEl.querySelectorAll<HTMLButtonElement>("[data-promotion]").forEach((button) => {
    button.textContent = GLYPHS[button.dataset.promotion || "q"] || "";
    button.classList.toggle("white", color === "w");
    button.classList.toggle("black", color === "b");
  });
  pickerEl.dataset.square = square;
  pickerEl.classList.remove("hidden");
}

function cancelPromotion(rerender = true): void {
  pendingPromotion = null;
  hidePromotion();
  if (rerender) {
    st.selected = null;
    st.legal.clear();
    render();
  }
}

function applyMove(from: Square, to: Square, promotion?: PieceSymbol): void {
  const gameMove = st.moves[st.index];
  const uci = `${from}${to}${promotion ?? ""}`;
  const matched = !st.variation.length && Boolean(gameMove) && gameMove.uci === uci;

  let move: Move;
  try {
    move = st.chess.move({ from, to, promotion });
  } catch {
    clearSelection();
    return;
  }

  st.selected = null;
  st.legal.clear();
  pendingPromotion = null;
  hidePromotion();

  if (matched) {
    // Let the modal advance the review to the next game ply.
    notify("matched");
    return;
  }

  st.variation.push({ san: move.san, from: move.from, to: move.to });
  st.lastFrom = move.from;
  st.lastTo = move.to;
  render();
  notify("variation");
}

function attemptMove(from: Square, to: Square, promotion?: PieceSymbol): void {
  const target = st.legal.get(to);
  if (!target) {
    clearSelection();
    return;
  }
  if (!promotion && target.promotion) {
    pendingPromotion = { from, to };
    showPromotion(to);
    return;
  }
  applyMove(from, to, promotion ?? target.promotion ?? undefined);
}

function updateDropHighlight(target: Square | null): void {
  boardEl?.querySelectorAll(".board-square.drop").forEach((node) => node.classList.remove("drop"));
  if (!target) return;
  const cell = boardEl?.querySelector<HTMLElement>(
    `.board-square[data-square="${target}"]`,
  );
  cell?.classList.add("drop");
}

function cleanupDrag(): void {
  if (drag?.piece) {
    drag.piece.style.transform = "";
    drag.piece.style.pointerEvents = "";
    drag.piece.classList.remove("dragging");
  }
  updateDropHighlight(null);
  drag = null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (pendingPromotion) {
    cancelPromotion();
    return;
  }

  const cell = (event.target as HTMLElement).closest<HTMLElement>(".board-square");
  const square = cell?.dataset.square as Square | undefined;
  if (!cell || !square) return;

  if (st.selected && st.legal.has(square)) {
    event.preventDefault();
    attemptMove(st.selected, square);
    return;
  }

  const piece = st.chess.get(square);
  if (piece && piece.color === st.chess.turn()) {
    const wasSelected = st.selected === square;
    if (!wasSelected) select(square);
    const pieceEl =
      boardEl?.querySelector<HTMLElement>(
        `.board-square[data-square="${square}"] .board-piece`,
      ) ?? null;
    drag = {
      from: square,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      wasSelected,
      piece: pieceEl,
      drop: null,
    };
    try {
      boardEl?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture may be unavailable */
    }
    return;
  }

  if (st.selected) clearSelection();
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;

  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.piece?.classList.add("dragging");
    if (drag.piece) drag.piece.style.pointerEvents = "none";
  }

  event.preventDefault();
  if (drag.piece) {
    drag.piece.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`;
  }

  const target = squareAtPoint(event.clientX, event.clientY);
  if (target !== drag.drop) {
    drag.drop = target;
    updateDropHighlight(target);
  }
}

function onPointerUp(event: PointerEvent): void {
  if (!drag) return;
  const active = drag;
  const target = squareAtPoint(event.clientX, event.clientY) ?? active.drop;
  cleanupDrag();

  if (active.moved) {
    if (target && target !== active.from) attemptMove(active.from, target);
    return;
  }

  if (active.wasSelected && (!target || target === active.from)) {
    clearSelection();
  }
}

export function initBoard(onChange: BoardCallback): void {
  st.onChange = onChange;
  if (bound) return;
  bound = true;

  const board = byId<HTMLElement>("board");
  const arrows = byId<SVGSVGElement>("board-arrows");
  const picker = byId<HTMLElement>("promotion-picker");
  boardEl = board;
  arrowsEl = arrows;
  pickerEl = picker;

  board.addEventListener("pointerdown", onPointerDown);
  board.addEventListener("pointermove", onPointerMove);
  board.addEventListener("pointerup", onPointerUp);
  board.addEventListener("pointercancel", cleanupDrag);

  picker.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-promotion]");
    if (!button) return;
    const pending = pendingPromotion;
    if (!pending) return;
    const piece = (button.dataset.promotion || "q") as PieceSymbol;
    pendingPromotion = null;
    hidePromotion();
    applyMove(pending.from, pending.to, piece);
  });

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && pendingPromotion) {
        event.preventDefault();
        event.stopPropagation();
        cancelPromotion();
      }
    },
    true,
  );
}

export function showGamePosition(game: GameMetrics, index: number, flipped: boolean): void {
  st.game = game;
  st.moves = gameMoves(game);
  st.index = Math.max(0, Math.min(index, st.moves.length));
  st.flipped = flipped;
  st.variation = [];
  st.selected = null;
  st.legal.clear();
  pendingPromotion = null;
  hidePromotion();

  st.chess = replay(st.moves, st.index) ?? new Chess();
  const last = st.index > 0 ? st.moves[st.index - 1] : null;
  st.lastFrom = last?.uci ? last.uci.slice(0, 2) : null;
  st.lastTo = last?.uci ? last.uci.slice(2, 4) : null;
  render();
}

export function setBoardFlipped(flipped: boolean): void {
  st.flipped = flipped;
  render();
}

export function undoBoardMove(): void {
  if (!st.variation.length) return;
  st.chess.undo();
  st.variation.pop();
  st.selected = null;
  st.legal.clear();
  pendingPromotion = null;
  hidePromotion();

  if (!st.variation.length) {
    if (st.game) showGamePosition(st.game, st.index, st.flipped);
    notify("variation");
    return;
  }

  const last = st.variation[st.variation.length - 1];
  st.lastFrom = last.from;
  st.lastTo = last.to;
  render();
  notify("variation");
}

export function resetBoardVariation(): void {
  if (!st.game || !st.variation.length) return;
  showGamePosition(st.game, st.index, st.flipped);
  notify("variation");
}

export function boardSnapshot(): {
  variation: boolean;
  history: string[];
  turn: "w" | "b";
  check: boolean;
  gameOver: boolean;
} {
  return {
    variation: st.variation.length > 0,
    history: st.variation.map((move) => move.san),
    turn: st.chess.turn(),
    check: st.chess.isCheck(),
    gameOver: st.chess.isGameOver(),
  };
}
