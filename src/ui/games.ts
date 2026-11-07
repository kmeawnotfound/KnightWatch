import type { GameMetrics } from "../lib/types";
import { clearNode, el, setText } from "./dom";
import { fmtNumber, fmtPct, scoreClass, scoreColor, titleCase } from "./format";
import { openGame } from "./modal";
import { state } from "./state";

export function populateSpeedFilter(games: GameMetrics[]): void {
  const select = document.getElementById("filter-speed") as HTMLSelectElement | null;
  if (!select) return;
  const current = select.value || "all";
  const speeds = Array.from(new Set(games.map((game) => game.speed).filter(Boolean))).sort();
  clearNode(select);
  const all = el("option", null, "All speeds");
  all.value = "all";
  select.appendChild(all);
  speeds.forEach((speed) => {
    const option = el("option", null, titleCase(speed));
    option.value = speed;
    select.appendChild(option);
  });
  select.value = speeds.includes(current) ? current : "all";
  state.filters.speed = select.value;
}

function filteredGames(): GameMetrics[] {
  const games = state.report?.games || [];
  return games.filter((game) => {
    if (state.filters.result !== "all" && game.result !== state.filters.result) return false;
    if (state.filters.color !== "all" && game.color !== state.filters.color) return false;
    if (state.filters.speed !== "all" && game.speed !== state.filters.speed) return false;
    return true;
  });
}

function sortedGames(games: GameMetrics[]): GameMetrics[] {
  const key = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...games].sort((a, b) => {
    const recordA = a as unknown as Record<string, unknown>;
    const recordB = b as unknown as Record<string, unknown>;
    let av = recordA[key];
    let bv = recordB[key];
    if (key === "date") {
      av = a.created_at || 0;
      bv = b.created_at || 0;
    }
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * dir;
    }
    return (Number(av) - Number(bv)) * dir;
  });
}

export function renderGames(): void {
  const tbody = document.getElementById("games-body");
  if (!tbody) return;
  clearNode(tbody);
  const all = filteredGames();
  const sorted = sortedGames(all);
  const limit = 300;
  const shown = sorted.slice(0, limit);

  shown.forEach((game) => {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.addEventListener("click", () => openGame(game));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openGame(game);
      }
    });

    row.appendChild(el("td", "game-date", game.date || "—"));

    const opponent = el("td", "game-opponent");
    opponent.appendChild(el("span", null, game.opponent || "—"));
    opponent.appendChild(el("small", null, `${titleCase(game.speed)} · ${game.opening || ""}`.replace(/ · $/, "")));
    row.appendChild(opponent);

    const color = el("td");
    color.appendChild(el("span", `chip ${game.color}`, game.color === "white" ? "W" : "B"));
    row.appendChild(color);

    const result = el("td");
    result.appendChild(el("span", `chip ${game.result}`, titleCase(game.result)));
    row.appendChild(result);

    row.appendChild(el("td", "num", String(game.player_rating ?? "—")));
    const acplCell = el(
      "td",
      "num",
      game.acpl === null || game.acpl === undefined ? "—" : fmtNumber(game.acpl, 1),
    );
    if (game.acpl !== null && game.acpl !== undefined) acplCell.classList.add(scoreClass(100 - game.acpl));
    row.appendChild(acplCell);
    row.appendChild(el("td", "num", fmtPct(game.accuracy, 1)));
    row.appendChild(
      el(
        "td",
        "num",
        game.fast_accuracy === null || game.fast_accuracy === undefined
          ? "—"
          : fmtPct(game.fast_accuracy, 1),
      ),
    );

    const signal = el("td");
    const signalWrap = el("div", "signal-cell");
    const bar = el("div", "signal-bar");
    const fill = el("span");
    fill.style.width = `${Math.max(2, Math.min(100, Number(game.suspicion) || 0))}%`;
    fill.style.background = scoreColor(Number(game.suspicion) || 0);
    bar.appendChild(fill);
    signalWrap.appendChild(bar);
    signalWrap.appendChild(el("span", "signal-num", String(game.suspicion ?? "—")));
    signal.appendChild(signalWrap);
    row.appendChild(signal);

    tbody.appendChild(row);
  });

  const note = document.getElementById("table-note");
  if (note) {
    if (!all.length) {
      note.textContent = "No games match these filters.";
    } else if (all.length > limit) {
      note.textContent = `Showing the top ${limit} of ${all.length} filtered games. Sort or filter to narrow the list. Click a row for the move-by-move review.`;
    } else {
      note.textContent = `${all.length} game${all.length === 1 ? "" : "s"} shown. Click a row for the move-by-move review.`;
    }
  }
  setText(document.getElementById("games-sub"), `${all.length} of ${(state.report?.games || []).length} games`);
}
