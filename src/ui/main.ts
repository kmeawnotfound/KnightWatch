import "../styles.css";

import { byId, $$ } from "./dom";
import { disposeEngine, initEngineStatus, warmEngine } from "./engine-status";
import { els } from "./els";
import { compareSelected, closeLibrary, openLibrary } from "./library";
import { closeModal, setBoardIndex, toggleBoardFlip } from "./modal";
import { cancelJob, newScan } from "./progress";
import { renderGames } from "./games";
import { loadDemo, loadJobReport, setTab, submitChessCom, submitPgn, submitScan } from "./scan";
import { exportCsv, exportHtml, exportJson, importJson } from "./share";
import { state } from "./state";
import { gameMoves } from "./view-types";

function bindEvents(): void {
  byId("tab-lichess").addEventListener("click", () => setTab("lichess"));
  byId("tab-chesscom").addEventListener("click", () => setTab("chesscom"));
  byId("tab-pgn").addEventListener("click", () => setTab("pgn"));
  byId("tab-demo").addEventListener("click", () => setTab("demo"));

  els.scanForm.addEventListener("submit", submitScan);
  els.ccForm.addEventListener("submit", submitChessCom);
  els.pgnForm.addEventListener("submit", submitPgn);
  els.scanForm.addEventListener("focusin", warmEngine, { once: true });
  els.ccForm.addEventListener("focusin", warmEngine, { once: true });
  els.pgnForm.addEventListener("focusin", warmEngine, { once: true });

  byId("error-close").addEventListener("click", () => {
    els.errorBanner.classList.add("hidden");
  });
  els.cancelJob.addEventListener("click", () => void cancelJob());
  byId("new-scan").addEventListener("click", newScan);

  byId("export-json").addEventListener("click", exportJson);
  byId("export-csv").addEventListener("click", exportCsv);
  byId("export-html").addEventListener("click", exportHtml);

  const importButton = byId<HTMLButtonElement>("import-json");
  const importFile = byId<HTMLInputElement>("import-file");
  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    if (file) void importJson(file);
    importFile.value = "";
  });

  byId("demo-clean").addEventListener("click", () => void loadDemo("clean"));
  byId("demo-suspect").addEventListener("click", () => void loadDemo("suspect"));

  byId("filter-result").addEventListener("change", (event) => {
    state.filters.result = (event.target as HTMLSelectElement).value;
    renderGames();
  });
  byId("filter-color").addEventListener("change", (event) => {
    state.filters.color = (event.target as HTMLSelectElement).value;
    renderGames();
  });
  byId("filter-speed").addEventListener("change", (event) => {
    state.filters.speed = (event.target as HTMLSelectElement).value;
    renderGames();
  });

  $$<HTMLTableCellElement>(".games-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort || "suspicion";
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
      } else {
        state.sortKey = key;
        state.sortDir = "desc";
      }
      $$(".games-table th").forEach((node) => node.classList.remove("sorted", "asc"));
      th.classList.add("sorted");
      if (state.sortDir === "asc") th.classList.add("asc");
      renderGames();
    });
  });

  byId("modal-close").addEventListener("click", closeModal);
  $$("[data-close]").forEach((node) => node.addEventListener("click", closeModal));

  byId("board-first").addEventListener("click", () => setBoardIndex(0));
  byId("board-prev").addEventListener("click", () => setBoardIndex(state.boardIndex - 1));
  byId("board-next").addEventListener("click", () => setBoardIndex(state.boardIndex + 1));
  byId("board-last").addEventListener("click", () => {
    if (state.selectedGame) setBoardIndex(gameMoves(state.selectedGame).length);
  });
  byId("board-flip").addEventListener("click", toggleBoardFlip);

  byId("open-library").addEventListener("click", () => void openLibrary());
  byId("library-close").addEventListener("click", closeLibrary);
  $$("[data-library-close]").forEach((node) => node.addEventListener("click", closeLibrary));
  byId("library-compare").addEventListener("click", () => void compareSelected());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      closeLibrary();
      return;
    }
    if (!state.selectedGame) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setBoardIndex(state.boardIndex - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setBoardIndex(state.boardIndex + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setBoardIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setBoardIndex(gameMoves(state.selectedGame).length);
    }
  });
}

function init(): void {
  bindEvents();
  initEngineStatus();
  window.addEventListener("pagehide", disposeEngine);
  const jobId = new URLSearchParams(window.location.search).get("job");
  if (jobId) void loadJobReport(jobId);
}

init();
