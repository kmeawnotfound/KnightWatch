import type { GameMetrics } from "../lib/types";
import { fmtPawns } from "./format";
import { scoreColor } from "./format";
import { gameMoves, moveNumber, type MoveView } from "./view-types";

const NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag);
}

export function drawGameChart(svg: SVGSVGElement, games: GameMetrics[]): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const width = 900;
  const height = 240;
  const left = 42;
  const right = 14;
  const top = 16;
  const bottom = 34;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const ordered = [...games].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  if (!ordered.length) {
    const text = svgEl("text");
    text.setAttribute("x", String(width / 2));
    text.setAttribute("y", String(height / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = "No games";
    svg.appendChild(text);
    return;
  }

  [0, 25, 50, 75, 100].forEach((value) => {
    const y = top + plotH * (1 - value / 100);
    const line = svgEl("line");
    line.setAttribute("x1", String(left));
    line.setAttribute("x2", String(width - right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid-line");
    svg.appendChild(line);
    const label = svgEl("text");
    label.setAttribute("x", String(left - 8));
    label.setAttribute("y", String(y + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = String(value);
    svg.appendChild(label);
  });

  const slot = plotW / ordered.length;
  const barW = Math.max(2, Math.min(22, slot * 0.66));
  ordered.forEach((game, index) => {
    const score = Number(game.suspicion) || 0;
    const x = left + slot * index + (slot - barW) / 2;
    const y = top + plotH * (1 - score / 100);
    const bar = svgEl("rect");
    bar.setAttribute("x", String(x));
    bar.setAttribute("y", String(y));
    bar.setAttribute("width", String(barW));
    bar.setAttribute("height", String(Math.max(1, top + plotH - y)));
    bar.setAttribute("rx", String(Math.min(3, barW / 2)));
    bar.setAttribute("fill", scoreColor(score));
    bar.setAttribute("opacity", "0.9");
    bar.setAttribute("class", "chart-bar");
    const title = svgEl("title");
    title.textContent = `${game.date || "unknown date"} · ${game.color === "white" ? "White" : "Black"} vs ${game.opponent}\nResult: ${game.result} · ACPL ${game.acpl ?? "—"} · Accuracy ${game.accuracy ?? "—"}%\nSignal ${score}/100`;
    bar.appendChild(title);
    svg.appendChild(bar);
  });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const labelLeft = svgEl("text");
  labelLeft.setAttribute("x", String(left));
  labelLeft.setAttribute("y", String(height - 10));
  labelLeft.setAttribute("class", "chart-axis-label");
  labelLeft.textContent = first.date || "";
  svg.appendChild(labelLeft);
  const labelRight = svgEl("text");
  labelRight.setAttribute("x", String(width - right));
  labelRight.setAttribute("y", String(height - 10));
  labelRight.setAttribute("text-anchor", "end");
  labelRight.setAttribute("class", "chart-axis-label");
  labelRight.textContent = last.date || "";
  svg.appendChild(labelRight);
}

export function drawEvalChart(svg: SVGSVGElement, game: GameMetrics): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const width = 900;
  const height = 220;
  const left = 34;
  const right = 12;
  const top = 14;
  const bottom = 22;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const center = top + plotH / 2;
  const scale = plotH / 2 / 6;

  const defs = svgEl("defs");
  const gradient = svgEl("linearGradient");
  gradient.setAttribute("id", "eval-gradient");
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("x2", "0");
  gradient.setAttribute("y2", "1");
  const stopTop = svgEl("stop");
  stopTop.setAttribute("offset", "0%");
  stopTop.setAttribute("stop-color", "#4fd1c5");
  stopTop.setAttribute("stop-opacity", "0.35");
  const stopMid = svgEl("stop");
  stopMid.setAttribute("offset", "50%");
  stopMid.setAttribute("stop-color", "#4fd1c5");
  stopMid.setAttribute("stop-opacity", "0.04");
  const stopBottom = svgEl("stop");
  stopBottom.setAttribute("offset", "100%");
  stopBottom.setAttribute("stop-color", "#ff6b6b");
  stopBottom.setAttribute("stop-opacity", "0.35");
  gradient.appendChild(stopTop);
  gradient.appendChild(stopMid);
  gradient.appendChild(stopBottom);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  const centerLine = svgEl("line");
  centerLine.setAttribute("x1", String(left));
  centerLine.setAttribute("x2", String(width - right));
  centerLine.setAttribute("y1", String(center));
  centerLine.setAttribute("y2", String(center));
  centerLine.setAttribute("stroke", "#2a3a4c");
  centerLine.setAttribute("stroke-width", "1");
  centerLine.setAttribute("stroke-dasharray", "4 4");
  svg.appendChild(centerLine);

  const moves = gameMoves(game).filter(
    (move) => move.eval_cp !== null && move.eval_cp !== undefined,
  );
  if (!moves.length) {
    const text = svgEl("text");
    text.setAttribute("x", String(width / 2));
    text.setAttribute("y", String(height / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = "No engine evaluations for this game";
    svg.appendChild(text);
    return;
  }

  const points = moves.map((move, index) => {
    const x = left + (moves.length === 1 ? plotW / 2 : (index / (moves.length - 1)) * plotW);
    const pawns = Math.max(-6, Math.min(6, (Number(move.eval_cp) || 0) / 100));
    const y = center - pawns * scale;
    return { x, y, move };
  });

  const area = svgEl("path");
  let d = `M ${points[0].x} ${center} L ${points[0].x} ${points[0].y}`;
  points.forEach((point) => {
    d += ` L ${point.x} ${point.y}`;
  });
  d += ` L ${points[points.length - 1].x} ${center} Z`;
  area.setAttribute("d", d);
  area.setAttribute("fill", "url(#eval-gradient)");
  svg.appendChild(area);

  const line = svgEl("path");
  line.setAttribute(
    "d",
    points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "),
  );
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#b8c6d6");
  line.setAttribute("stroke-width", "1.6");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  points.forEach(({ x, y, move }) => {
    const judgment = move.judgment;
    if (!judgment) return;
    const dot = svgEl("circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", judgment === "blunder" ? "3.4" : "2.6");
    dot.setAttribute(
      "fill",
      judgment === "blunder" ? "#ff6b6b" : judgment === "mistake" ? "#f08c4c" : "#f5b84c",
    );
    const title = svgEl("title");
    title.textContent = `${moveNumber(move)}${move.color === "white" ? "." : "..."} ${move.san} · eval ${fmtPawns(move.eval_cp)} · ${judgment}`;
    dot.appendChild(title);
    svg.appendChild(dot);
  });

  ["+6", "0", "−6"].forEach((label, index) => {
    const text = svgEl("text");
    text.setAttribute("x", String(left - 8));
    text.setAttribute(
      "y",
      String(index === 0 ? top + 4 : index === 1 ? center + 3 : height - bottom + 4),
    );
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = label;
    svg.appendChild(text);
  });
}

export interface TimingPoint {
  tension: number;
  time: number;
  move: MoveView;
  game: GameMetrics;
}

const LOG_MAX = 300;

function timeNorm(seconds: number): number {
  const value = Math.max(0, Math.min(LOG_MAX, seconds));
  return Math.log10(1 + value) / Math.log10(1 + LOG_MAX);
}

export function drawTimingChart(svg: SVGSVGElement, points: TimingPoint[]): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const width = 900;
  const height = 300;
  const left = 48;
  const right = 18;
  const top = 18;
  const bottom = 40;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  if (!points.length) {
    const text = svgEl("text");
    text.setAttribute("x", String(width / 2));
    text.setAttribute("y", String(height / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = "No clock data in these games";
    svg.appendChild(text);
    return;
  }

  // Horizontal grid at a few readable clock values.
  [0, 1, 5, 30, 300].forEach((seconds) => {
    const y = top + plotH * (1 - timeNorm(seconds));
    const line = svgEl("line");
    line.setAttribute("x1", String(left));
    line.setAttribute("x2", String(width - right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid-line");
    svg.appendChild(line);
    const label = svgEl("text");
    label.setAttribute("x", String(left - 8));
    label.setAttribute("y", String(y + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = seconds === 0 ? "0s" : seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
    svg.appendChild(label);
  });

  // Vertical grid at tension 0 / 0.5 / 1.
  [0, 0.5, 1].forEach((value) => {
    const x = left + plotW * value;
    const line = svgEl("line");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
    line.setAttribute("y1", String(top));
    line.setAttribute("y2", String(height - bottom));
    line.setAttribute("class", "chart-grid-line");
    svg.appendChild(line);
    const label = svgEl("text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(height - 12));
    label.setAttribute("text-anchor", value === 0 ? "start" : value === 1 ? "end" : "middle");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = value === 0 ? "Decisive" : value === 1 ? "Balanced" : "Tense";
    svg.appendChild(label);
  });

  // Fast-move threshold line (3 seconds).
  const fastY = top + plotH * (1 - timeNorm(3));
  const fastLine = svgEl("line");
  fastLine.setAttribute("x1", String(left));
  fastLine.setAttribute("x2", String(width - right));
  fastLine.setAttribute("y1", String(fastY));
  fastLine.setAttribute("y2", String(fastY));
  fastLine.setAttribute("stroke", "#4fd1c5");
  fastLine.setAttribute("stroke-width", "1");
  fastLine.setAttribute("stroke-dasharray", "5 5");
  fastLine.setAttribute("opacity", "0.45");
  svg.appendChild(fastLine);
  const fastLabel = svgEl("text");
  fastLabel.setAttribute("x", String(width - right));
  fastLabel.setAttribute("y", String(fastY - 4));
  fastLabel.setAttribute("text-anchor", "end");
  fastLabel.setAttribute("class", "chart-axis-label");
  fastLabel.textContent = "3s";
  svg.appendChild(fastLabel);

  points.forEach(({ tension, time, move, game }) => {
    const x = left + plotW * Math.max(0, Math.min(1, tension));
    const y = top + plotH * (1 - timeNorm(time));
    const dot = svgEl("circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", move.is_best ? "3.4" : "2.6");
    dot.setAttribute("fill", judgmentColor(move));
    dot.setAttribute("opacity", "0.85");
    const title = svgEl("title");
    title.textContent = `${game.opponent || "?"} · ${moveNumber(move)}${move.color === "white" ? "." : "..."} ${move.san}\nThink time ${time.toFixed(1)}s · tension ${(tension * 100).toFixed(0)}%${move.is_best ? " · engine best" : ""}`;
    dot.appendChild(title);
    svg.appendChild(dot);
  });
}

function judgmentColor(move: MoveView): string {
  if (move.judgment === "blunder") return "#ff6b6b";
  if (move.judgment === "mistake") return "#f08c4c";
  if (move.judgment === "inaccuracy") return "#f5b84c";
  if (move.is_best) return "#4fd1c5";
  return "#8fa0b5";
}
