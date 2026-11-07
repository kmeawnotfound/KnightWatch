import type { GameMetrics } from "../lib/types";
import { drawTimingChart, type TimingPoint } from "./chart";
import { byId, clearNode, el } from "./dom";
import { fmtPct, fmtTime } from "./format";
import { openGame } from "./modal";
import { state } from "./state";
import { gameMoves, moveNumber, tensionOf, type MoveView } from "./view-types";

const FAST_SECONDS = 3;
const HARD_TENSION = 0.6;

export function renderTiming(): void {
  const points: TimingPoint[] = [];

  for (const game of state.report?.games || []) {
    if (game.detail_available === false) continue;
    for (const move of gameMoves(game)) {
      if (move.color !== game.color) continue;
      if (move.think_time === null || move.think_time === undefined) continue;
      if (move.eval_cp === null || move.eval_cp === undefined) continue;
      points.push({ game, move, tension: tensionOf(move), time: move.think_time });
    }
  }

  drawTimingChart(byId<SVGSVGElement>("timing-chart"), points);
  renderStats(points);
  renderInstantList(points);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderStats(points: TimingPoint[]): void {
  const container = byId("timing-stats");
  clearNode(container);

  if (!points.length) {
    container.appendChild(el("div", "critical-empty", "These games have no clock data."));
    return;
  }

  const hard = points.filter((point) => point.tension >= HARD_TENSION);
  const easy = points.filter((point) => point.tension < HARD_TENSION);
  const hardMean = mean(hard.map((point) => point.time));
  const easyMean = mean(easy.map((point) => point.time));
  const hardFast = hard.filter((point) => point.time <= FAST_SECONDS);
  const hardStrongFast = hardFast.filter(
    (point) => point.move.is_best === true || (point.move.accuracy ?? 0) >= 90,
  );
  const fastShare = hard.length ? hardStrongFast.length / hard.length : null;

  const stats: Array<[string, string, string]> = [
    ["Timed moves", String(points.length), `${hard.length} in tense positions`],
    ["Avg. time (tense)", hardMean === null ? "—" : fmtTime(hardMean), "positions near equality"],
    ["Avg. time (clear)", easyMean === null ? "—" : fmtTime(easyMean), "positions already decided"],
    ["Fast & strong", fastShare === null ? "—" : fmtPct(fastShare * 100, 0), `≤${FAST_SECONDS}s in tense positions`],
  ];

  for (const [label, value, sub] of stats) {
    const card = el("div", "timing-stat");
    card.appendChild(el("span", "timing-stat-label", label));
    card.appendChild(el("strong", null, value));
    card.appendChild(el("span", "timing-stat-sub", sub));
    container.appendChild(card);
  }
}

function renderInstantList(points: TimingPoint[]): void {
  const container = byId("timing-list");
  clearNode(container);

  const instant = points
    .filter(
      (point) =>
        point.tension >= HARD_TENSION &&
        point.time <= FAST_SECONDS &&
        (point.move.is_best === true || (point.move.accuracy ?? 0) >= 90),
    )
    .sort((a, b) => b.tension - a.tension || a.time - b.time)
    .slice(0, 6);

  if (!instant.length) {
    container.appendChild(
      el("div", "critical-empty", "No fast, strong moves in tense positions were found."),
    );
    return;
  }

  for (const { game, move, time, tension } of instant) {
    const row = el("button", "critical-row find") as HTMLButtonElement;
    row.type = "button";

    const head = el("span", "critical-move");
    head.appendChild(el("strong", null, `${moveNumber(move)}${move.color === "white" ? "." : "..."} ${move.san}`));
    if (move.is_best) head.appendChild(el("span", "critical-badge", "best"));
    row.appendChild(head);

    row.appendChild(el("span", "critical-meta", `vs ${game.opponent || "?"} · ${game.date || "?"}`));

    const stat = el("span", "critical-stat");
    stat.textContent = `${fmtTime(time)} · tension ${Math.round(tension * 100)}%`;
    row.appendChild(stat);

    row.addEventListener("click", () => openGame(game, move.ply));
    container.appendChild(row);
  }
}
