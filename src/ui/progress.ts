import type { JobSnapshot } from "../lib/types";
import { clearNode, el } from "./dom";
import { els } from "./els";
import { fmtDuration, titleCase } from "./format";
import { clearError, showError, toast } from "./notify";
import { renderReport } from "./report";
import { jobs, state } from "./state";

const phaseLabels: Record<string, string> = {
  queued: "Queued",
  profile: "Profile",
  fetching: "Downloading",
  parsing: "Parsing",
  engine: "Engine",
  analyzing: "Analysing",
  scoring: "Scoring",
  done: "Complete",
  error: "Error",
  cancelled: "Cancelled",
};

export function setProgress(progress: { percent?: number }, phase: string, title: string): void {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  els.progressPhase.textContent = phaseLabels[phase] || titleCase(phase || "working");
  els.progressTitle.textContent = title;
  els.progressPercent.textContent = `${Math.round(percent)}%`;
  els.progressFill.style.width = `${percent}%`;
}

export function updateProgress(job: JobSnapshot): void {
  const progress = job.progress || ({} as JobSnapshot["progress"]);
  const phase = job.phase || job.status;
  const percent = progress.percent || 0;
  const sourceName = job.kind === "chesscom" ? "Chess.com" : "Lichess";
  let title = "Working…";
  if (phase === "queued") title = "Waiting for a free analysis slot…";
  else if (phase === "profile") title = `Loading the ${sourceName} profile…`;
  else if (phase === "fetching") title = `Downloading games from ${sourceName}…`;
  else if (phase === "parsing") title = "Parsing PGN…";
  else if (phase === "engine") title = "Loading Stockfish WASM…";
  else if (phase === "analyzing") {
    title = progress.current_game
      ? `Analysing game ${progress.analyzed || 0} of ${progress.total_games || "?"}…`
      : "Analysing positions…";
  } else if (phase === "scoring") title = "Building the report…";
  else if (phase === "done") title = "Report ready";
  else if (phase === "error") title = "Scan failed";
  else if (phase === "cancelled") title = "Scan cancelled";
  setProgress(progress, phase, title);

  if (phase === "fetching") {
    const total = progress.total_hint;
    els.progressCounts.textContent = total
      ? `${progress.fetched || 0} of ~${total} games downloaded`
      : `${progress.fetched || 0} games downloaded`;
  } else if (phase === "analyzing") {
    els.progressCounts.textContent = `${progress.analyzed || 0} / ${progress.total_games || 0} games analysed`;
  } else if (phase === "done") {
    els.progressCounts.textContent = `${progress.total_games || progress.fetched || 0} games processed`;
  } else {
    els.progressCounts.textContent = "";
  }

  let eta = progress.eta_seconds;
  if (phase === "fetching" && progress.total_hint && progress.fetched) {
    const elapsed = (Date.now() - new Date(job.started_at || Date.now()).getTime()) / 1000;
    eta = (elapsed / Math.max(progress.fetched, 1)) * (progress.total_hint - progress.fetched);
  }
  els.progressEta.textContent = eta && eta > 1 ? `~${fmtDuration(eta)} remaining` : "";

  const logs = job.logs || [];
  if (logs.length !== state.lastLogCount) {
    state.lastLogCount = logs.length;
    clearNode(els.logList);
    logs.slice(-12).forEach((entry) => {
      const li = el("li", null, `${entry.ts ? entry.ts.slice(11, 19) : ""}  ${entry.message}`);
      els.logList.appendChild(li);
    });
    els.logList.scrollTop = els.logList.scrollHeight;
  }
}

function enableForms(): void {
  els.scanSubmit.disabled = false;
  els.ccSubmit.disabled = false;
  els.pgnSubmit.disabled = false;
}

export async function pollJob(): Promise<void> {
  if (!state.jobId || state.finished) return;
  try {
    const job = jobs.get(state.jobId);
    if (!job) throw new Error("This scan is no longer available in this tab.");
    state.pollErrors = 0;
    updateProgress(job);
    if (job.status === "done") {
      state.finished = true;
      stopPolling();
      enableForms();
      try {
        const report = await jobs.getReport(state.jobId);
        if (!report) throw new Error("The report could not be read from browser storage.");
        renderReport(report);
      } catch (error) {
        showError(error, "Report could not be loaded");
      }
    } else if (job.status === "error") {
      state.finished = true;
      stopPolling();
      enableForms();
      showError({ message: job.error, hint: job.error_hint }, "Scan failed");
    } else if (job.status === "cancelled") {
      state.finished = true;
      stopPolling();
      enableForms();
      els.progressPanel.classList.add("hidden");
      toast("Scan cancelled");
    }
  } catch (error) {
    state.pollErrors += 1;
    if (state.pollErrors >= 5) {
      stopPolling();
      enableForms();
      showError(error, "Lost connection to the server");
    }
  }
}

export function stopPolling(): void {
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

export async function cancelJob(): Promise<void> {
  if (!state.jobId) return;
  try {
    const ok = jobs.cancel(state.jobId);
    if (!ok) throw new Error("This scan is no longer available.");
    toast("Cancellation requested");
  } catch (error) {
    toast((error as Error).message, true);
  }
}

export function newScan(): void {
  if (window.location.search) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  stopPolling();
  state.jobId = null;
  state.report = null;
  state.demo = false;
  state.finished = false;
  state.selectedGame = null;
  els.results.classList.add("hidden");
  els.progressPanel.classList.add("hidden");
  enableForms();
  clearError();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
