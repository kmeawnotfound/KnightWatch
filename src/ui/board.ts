import { Chess } from "chess.js";

import type { GameMetrics } from "../lib/types";
import { clearNode, el } from "./dom";
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

export function renderBoard(
  container: HTMLElement,
  arrows: SVGSVGElement,
  game: GameMetrics,
  index: number,
  flipped: boolean,
): void {
  const moves = gameMoves(game);
  const chess = replay(moves, index) ?? new Chess();
  const board = chess.board();

  clearNode(container);
  clearNode(arrows);

  const last = index > 0 ? moves[index - 1] : null;
  const from = last?.uci ? last.uci.slice(0, 2) : null;
  const to = last?.uci ? last.uci.slice(2, 4) : null;

  const rowOrder = [0, 1, 2, 3, 4, 5, 6, 7];
  const colOrder = [0, 1, 2, 3, 4, 5, 6, 7];
  if (flipped) {
    rowOrder.reverse();
    colOrder.reverse();
  }

  for (const r of rowOrder) {
    for (const c of colOrder) {
      const piece = board[r][c];
      const square = `${FILES[c]}${8 - r}`;
      const dark = (r + c) % 2 === 1;
      const cell = el("div", `board-square ${dark ? "dark" : "light"}`);
      cell.dataset.square = square;
      if (square === from) cell.classList.add("from");
      if (square === to) cell.classList.add("to");
      cell.setAttribute("aria-label", `${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`);

      if (piece) {
        cell.appendChild(
          el("span", `board-piece ${piece.color === "w" ? "white" : "black"}`, GLYPHS[piece.type] || ""),
        );
      }

      const displayRow = rowOrder.indexOf(r);
      const displayCol = colOrder.indexOf(c);
      if (displayRow === 7) cell.appendChild(el("span", "board-coord file", FILES[c]));
      if (displayCol === 0) cell.appendChild(el("span", "board-coord rank", String(8 - r)));

      container.appendChild(cell);
    }
  }

  if (last?.uci && from && to) {
    drawArrow(arrows, from, to, "#f0c674", flipped);
    if (last.best_uci && last.best_uci.length >= 4 && last.best_uci !== last.uci) {
      drawArrow(arrows, last.best_uci.slice(0, 2), last.best_uci.slice(2, 4), "#4fd1c5", flipped);
    }
  }
}
