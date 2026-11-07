import { criticalErrors, criticalFinds } from "../lib/highlights.js";
import type { CriticalMoment } from "../lib/highlights.js";
import { byId, clearNode, el } from "./dom";
import { fmtNumber, fmtTime } from "./format";
import { openGame } from "./modal";
import { state } from "./state";

export function renderCritical(): void {
  const report = state.report;
  const errors = report ? criticalErrors(report, 8) : [];
  const finds = report ? criticalFinds(report, 8) : [];
  renderList(byId("critical-errors"), errors, "error");
  renderList(byId("critical-finds"), finds, "find");
}

function renderList(container: HTMLElement, items: CriticalMoment[], kind: "error" | "find"): void {
  clearNode(container);
  if (!items.length) {
    container.appendChild(
      el(
        "div",
        "critical-empty",
        kind === "error"
          ? "No costly decisions in the analysed games."
          : "No engine-best moves were recorded for this report.",
      ),
    );
    return;
  }

  for (const { game, move } of items) {
    const row = el("button", `critical-row ${kind}`) as HTMLButtonElement;
    row.type = "button";

    const head = el("span", "critical-move");
    const number = move.move_no || Math.ceil(move.ply / 2);
    head.appendChild(el("strong", null, `${number}${move.color === "white" ? "." : "..."} ${move.san}`));
    if (move.is_best && kind === "find") {
      head.appendChild(el("span", "critical-badge", "best"));
    }
    row.appendChild(head);

    row.appendChild(el("span", "critical-meta", `vs ${game.opponent || "?"} · ${game.date || "?"}`));

    const stat = el("span", "critical-stat");
    if (kind === "error") {
      stat.textContent = `−${fmtNumber(move.loss_cp ?? 0, 0)} cp`;
      if (move.best_san && move.best_san !== move.san) stat.textContent += ` · best ${move.best_san}`;
    } else {
      stat.textContent =
        move.think_time !== null && move.think_time !== undefined
          ? fmtTime(move.think_time)
          : "no clock";
    }
    row.appendChild(stat);

    row.addEventListener("click", () => openGame(game, move.ply));
    container.appendChild(row);
  }
}
