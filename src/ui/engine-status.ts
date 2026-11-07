import { closeEnginePool, defaultWorkerCount, getEnginePool } from "../lib/engine.js";
import { els } from "./els";
import { $, setText } from "./dom";
import { state } from "./state";

export function initEngineStatus(): void {
  const workers = defaultWorkerCount();
  state.engineWorkers = workers;
  if (typeof WebAssembly === "object") {
    els.enginePill.classList.add("ok");
    setText(els.enginePillText, `Stockfish WASM · ${workers} worker${workers === 1 ? "" : "s"}`);
  } else {
    els.enginePill.classList.add("warn");
    setText(els.enginePillText, "WebAssembly unavailable");
  }
}

// Start the WASM pool as soon as the user shows intent (focusing a form
// field), so a later scan does not sit at "Preparing analysis…".
export function warmEngine(): void {
  if (state.warmStarted || typeof WebAssembly !== "object") return;
  const pane = $(".tab-pane.active");
  const mode = (pane.querySelector("select[id$='engine']") as HTMLSelectElement | null)?.value || "auto";
  if (mode === "lichess" || mode === "cloud") return;
  state.warmStarted = true;
  const workers = state.engineWorkers;
  const label = `Stockfish WASM · ${workers} worker${workers === 1 ? "" : "s"}`;
  if (!state.engineReady) setText(els.enginePillText, "Loading Stockfish…");
  getEnginePool()
    .then(() => {
      state.engineReady = true;
      els.enginePill.classList.add("ok");
      setText(els.enginePillText, label);
    })
    .catch(() => {
      state.warmStarted = false;
      setText(els.enginePillText, label);
    });
}

export function disposeEngine(): void {
  closeEnginePool();
}
