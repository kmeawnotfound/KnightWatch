import { $, byId } from "./dom";
import { els } from "./els";
import { clearError, showError, toast } from "./notify";
import { pollJob, setProgress, stopPolling } from "./progress";
import { renderReport } from "./report";
import { jobs, state } from "./state";

export type TabName = "lichess" | "chesscom" | "pgn" | "demo";

export function setTab(name: TabName): void {
  const mapping: Record<TabName, [string, string]> = {
    lichess: ["#tab-lichess", "#pane-lichess"],
    chesscom: ["#tab-chesscom", "#pane-chesscom"],
    pgn: ["#tab-pgn", "#pane-pgn"],
    demo: ["#tab-demo", "#pane-demo"],
  };
  (Object.keys(mapping) as TabName[]).forEach((key) => {
    const [tab, pane] = mapping[key];
    $(tab).classList.toggle("active", key === name);
    $(tab).setAttribute("aria-selected", key === name ? "true" : "false");
    $(pane).classList.toggle("active", key === name);
  });
}

function clearJobParam(): void {
  if (window.location.search) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

export async function submitScan(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  clearError();
  const username = (byId<HTMLInputElement>("username").value || "").trim();
  if (!username) {
    showError({ message: "Enter a Lichess username." }, "Missing username");
    return;
  }
  const payload = {
    username,
    perf: byId<HTMLSelectElement>("perf").value,
    max_games: Number(byId<HTMLSelectElement>("max-games").value),
    include_unrated: byId<HTMLInputElement>("include-unrated").checked,
    engine: byId<HTMLSelectElement>("engine").value,
    depth: Number(byId<HTMLSelectElement>("depth").value),
    samples: Number(byId<HTMLSelectElement>("samples").value),
    reanalyze: byId<HTMLInputElement>("reanalyze").checked,
  };
  await startJob("lichess", payload, els.scanSubmit);
}

export async function submitChessCom(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  clearError();
  const username = (byId<HTMLInputElement>("cc-username").value || "").trim();
  if (!username) {
    showError({ message: "Enter a Chess.com username." }, "Missing username");
    return;
  }
  const payload = {
    username,
    time_class: byId<HTMLSelectElement>("cc-perf").value,
    max_games: Number(byId<HTMLSelectElement>("cc-max").value),
    include_unrated: byId<HTMLInputElement>("cc-unrated").checked,
    engine: byId<HTMLSelectElement>("cc-engine").value,
    depth: Number(byId<HTMLSelectElement>("cc-depth").value),
    samples: Number(byId<HTMLSelectElement>("cc-samples").value),
  };
  await startJob("chesscom", payload, els.ccSubmit);
}

export async function submitPgn(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  clearError();
  const pgn = (byId<HTMLTextAreaElement>("pgn-text").value || "").trim();
  if (!pgn) {
    showError({ message: "Paste a PGN first." }, "Missing PGN");
    return;
  }
  const payload = {
    pgn,
    player: (byId<HTMLInputElement>("pgn-player").value || "").trim() || null,
    max_games: Number(byId<HTMLSelectElement>("pgn-max").value),
    engine: byId<HTMLSelectElement>("pgn-engine").value,
    depth: Number(byId<HTMLSelectElement>("pgn-depth").value),
    samples: Number(byId<HTMLSelectElement>("pgn-samples").value),
  };
  await startJob("pgn", payload, els.pgnSubmit);
}

async function startJob(
  kind: "lichess" | "chesscom" | "pgn",
  payload: Record<string, any>,
  button: HTMLButtonElement,
): Promise<void> {
  clearJobParam();
  state.demo = false;
  state.finished = false;
  state.pollErrors = 0;
  state.lastLogCount = -1;
  els.results.classList.add("hidden");
  els.progressPanel.classList.remove("hidden");
  els.progressPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  button.disabled = true;
  setProgress({ percent: 0 }, "queued", "Preparing the browser engine…");
  try {
    state.jobId =
      kind === "pgn"
        ? jobs.createPgnJob(payload)
        : kind === "chesscom"
          ? jobs.createChessComJob(payload)
          : jobs.createLichessJob(payload);
    state.finished = false;
    void pollJob();
    state.pollTimer = window.setInterval(() => void pollJob(), 850);
  } catch (error) {
    button.disabled = false;
    els.progressPanel.classList.add("hidden");
    showError(error, "Could not start scan");
  }
}

export async function loadDemo(kind: "clean" | "suspect"): Promise<void> {
  clearJobParam();
  clearError();
  stopPolling();
  state.jobId = null;
  state.demo = true;
  state.finished = true;
  try {
    const response = await fetch(`/demo_${kind}.json`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const report = await response.json();
    els.progressPanel.classList.add("hidden");
    renderReport(report);
    toast(kind === "suspect" ? "Synthetic suspect demo loaded" : "Clean GM demo loaded");
  } catch (error) {
    showError(error, "Demo unavailable");
  }
}

export async function loadJobReport(jobId: string): Promise<void> {
  stopPolling();
  state.jobId = jobId;
  state.demo = false;
  state.finished = true;
  try {
    const report = await jobs.getReport(jobId);
    if (!report) throw new Error("This report is not stored in this browser.");
    renderReport(report);
    toast("Saved report loaded");
  } catch (error) {
    showError(error, "Report unavailable");
  }
}
