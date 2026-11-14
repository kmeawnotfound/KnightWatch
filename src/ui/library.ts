import { downloadJson } from "../lib/export.js";
import { deleteReport, listReports, loadReport } from "../lib/storage.js";
import type { StoredReportInfo } from "../lib/storage.js";
import type { Report } from "../lib/types";
import { byId, clearNode, el } from "./dom";
import { fmtInt, fmtNumber, fmtPct, scoreColor } from "./format";
import { toast } from "./notify";
import { renderReport } from "./report";
import { state } from "./state";

export async function openLibrary(): Promise<void> {
  byId("library-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  state.librarySelection = [];
  await refreshLibrary();
}

export function closeLibrary(): void {
  byId("library-modal").classList.add("hidden");
  document.body.style.overflow = "";
}

async function refreshLibrary(): Promise<void> {
  const body = byId("library-body");
  clearNode(body);
  updateCompareButton();

  let entries: StoredReportInfo[] = [];
  try {
    entries = await listReports();
  } catch {
    entries = [];
  }

  if (!entries.length) {
    body.appendChild(
      el("div", "library-empty", "No saved reports yet. Run a scan or import a JSON report."),
    );
    return;
  }

  const list = el("div", "library-list");
  entries.forEach((entry) => list.appendChild(renderRow(entry)));
  body.appendChild(list);
}

function renderRow(entry: StoredReportInfo): HTMLElement {
  const row = el("div", "library-row");

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "library-check";
  check.checked = state.librarySelection.includes(entry.id);
  check.setAttribute("aria-label", `Select ${entry.username} for comparison`);
  check.addEventListener("change", () => {
    if (check.checked) {
      if (!state.librarySelection.includes(entry.id)) state.librarySelection.push(entry.id);
    } else {
      state.librarySelection = state.librarySelection.filter((id) => id !== entry.id);
    }
    updateCompareButton();
  });
  row.appendChild(check);

  const main = el("div", "library-main");
  const title = el("div", "library-title");
  title.appendChild(el("strong", null, entry.username || "Unknown player"));
  const score = el("span", "library-score", String(Math.round(entry.score)));
  score.style.color = scoreColor(entry.score);
  score.style.borderColor = scoreColor(entry.score);
  title.appendChild(score);
  title.appendChild(el("span", "library-verdict", entry.verdict || "—"));
  main.appendChild(title);

  const saved = entry.saved_at ? new Date(entry.saved_at).toLocaleString() : "unknown";
  main.appendChild(
    el(
      "div",
      "library-meta",
      `${fmtInt(entry.games)} games · ${entry.confidence_label || "—"} confidence · saved ${saved}`,
    ),
  );
  row.appendChild(main);

  const actions = el("div", "library-actions");

  const open = el("button", "btn tiny ghost", "Open") as HTMLButtonElement;
  open.type = "button";
  open.addEventListener("click", () => void openSaved(entry.id));
  actions.appendChild(open);

  const exportButton = el("button", "btn tiny ghost", "Export") as HTMLButtonElement;
  exportButton.type = "button";
  exportButton.addEventListener("click", () => void exportSaved(entry.id));
  actions.appendChild(exportButton);

  const remove = el("button", "btn tiny ghost danger", "Delete") as HTMLButtonElement;
  remove.type = "button";
  remove.addEventListener("click", () => void removeSaved(entry));
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

async function openSaved(id: string): Promise<void> {
  const report = await loadReport(id);
  if (!report) {
    toast("That report is no longer stored in this browser.", true);
    return;
  }
  state.jobId = id;
  state.demo = false;
  closeLibrary();
  renderReport(report);
  window.history.replaceState(null, "", `?job=${encodeURIComponent(id)}`);
}

async function exportSaved(id: string): Promise<void> {
  const report = await loadReport(id);
  if (!report) {
    toast("That report is no longer stored in this browser.", true);
    return;
  }
  downloadJson(report);
}

async function removeSaved(entry: StoredReportInfo): Promise<void> {
  const ok = window.confirm(`Delete the saved report for ${entry.username || "this player"}?`);
  if (!ok) return;
  await deleteReport(entry.id);
  state.librarySelection = state.librarySelection.filter((id) => id !== entry.id);
  if (state.jobId === entry.id) state.jobId = null;
  await refreshLibrary();
  toast("Report deleted");
}

function updateCompareButton(): void {
  const button = byId<HTMLButtonElement>("library-compare");
  button.classList.toggle("hidden", state.librarySelection.length !== 2);
}

export async function compareSelected(): Promise<void> {
  if (state.librarySelection.length !== 2) return;
  const ids = state.librarySelection.slice(0, 2);
  const [first, second] = await Promise.all(ids.map((id) => loadReport(id)));
  if (!first || !second) {
    toast("One of the selected reports is no longer available.", true);
    return;
  }
  renderCompare(first, second);
}

function renderCompare(first: Report, second: Report): void {
  const body = byId("library-body");
  clearNode(body);

  const back = el("button", "btn tiny ghost", "← Back to library") as HTMLButtonElement;
  back.type = "button";
  back.addEventListener("click", () => void refreshLibrary());
  body.appendChild(back);

  const heading = el("div", "compare-head");
  heading.appendChild(el("h4", null, "Report comparison"));
  heading.appendChild(
    el(
      "p",
      "muted small",
      "Deltas are second report minus first report. Positive deltas are not automatically worse — read them with the verdict and sample size.",
    ),
  );
  body.appendChild(heading);

  const table = el("table", "compare-table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Metric", reportLabel(first), reportLabel(second), "Δ"].forEach((text) => {
    headRow.appendChild(el("th", null, text));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const metricsA = first.summary.metrics || {};
  const metricsB = second.summary.metrics || {};

  const rows: Array<[string, string, string, string]> = [
    ["Score", String(Math.round(first.summary.score)), String(Math.round(second.summary.score)), signed(second.summary.score - first.summary.score, 0)],
    ["Verdict", first.summary.verdict || "—", second.summary.verdict || "—", ""],
    [
      "Confidence",
      `${first.summary.confidence_label || "—"} (${Math.round((first.summary.confidence || 0) * 100)}%)`,
      `${second.summary.confidence_label || "—"} (${Math.round((second.summary.confidence || 0) * 100)}%)`,
      "",
    ],
    ["Games", fmtInt(metricsA.games), fmtInt(metricsB.games), signed(numberDelta(metricsA.games, metricsB.games), 0)],
    [
      "Analysed moves",
      fmtInt(metricsA.analyzed_moves),
      fmtInt(metricsB.analyzed_moves),
      signed(numberDelta(metricsA.analyzed_moves, metricsB.analyzed_moves), 0),
    ],
    ["ACPL", fmtNumber(metricsA.acpl, 1), fmtNumber(metricsB.acpl, 1), signed(numberDelta(metricsA.acpl, metricsB.acpl), 1)],
    ["Accuracy", fmtPct(metricsA.accuracy, 1), fmtPct(metricsB.accuracy, 1), signed(numberDelta(metricsA.accuracy, metricsB.accuracy), 1)],
    ["Top-move match", fmtPct(metricsA.top_match, 1), fmtPct(metricsB.top_match, 1), signed(numberDelta(metricsA.top_match, metricsB.top_match), 1)],
    [
      "Fast-move accuracy",
      fmtPct(metricsA.fast_accuracy, 1),
      fmtPct(metricsB.fast_accuracy, 1),
      signed(numberDelta(metricsA.fast_accuracy, metricsB.fast_accuracy), 1),
    ],
    [
      "Performance",
      fmtInt(metricsA.performance),
      fmtInt(metricsB.performance),
      signed(numberDelta(metricsA.performance, metricsB.performance), 0),
    ],
    ["Avg. rating", fmtInt(metricsA.avg_rating), fmtInt(metricsB.avg_rating), signed(numberDelta(metricsA.avg_rating, metricsB.avg_rating), 0)],
  ];

  rows.forEach(([label, a, b, delta]) => {
    const row = document.createElement("tr");
    row.appendChild(el("td", null, label));
    row.appendChild(el("td", "num", a));
    row.appendChild(el("td", "num", b));
    row.appendChild(el("td", "num compare-delta", delta));
    tbody.appendChild(row);
  });

  const componentsA = new Map((first.summary.components || []).map((component) => [component.key, component]));
  const componentsB = new Map((second.summary.components || []).map((component) => [component.key, component]));
  const keys = Array.from(new Set([...componentsA.keys(), ...componentsB.keys()]));

  if (keys.length) {
    const section = document.createElement("tr");
    const cell = el("td", "compare-section", "Component z-scores");
    cell.colSpan = 4;
    section.appendChild(cell);
    tbody.appendChild(section);

    keys.forEach((key) => {
      const a = componentsA.get(key);
      const b = componentsB.get(key);
      const row = document.createElement("tr");
      row.appendChild(el("td", null, a?.label || b?.label || key));
      row.appendChild(el("td", "num", a ? signed(a.z, 2) : "—"));
      row.appendChild(el("td", "num", b ? signed(b.z, 2) : "—"));
      row.appendChild(el("td", "num compare-delta", a && b ? signed(b.z - a.z, 2) : "—"));
      tbody.appendChild(row);
    });
  }

  table.appendChild(tbody);
  const wrap = el("div", "compare-wrap");
  wrap.appendChild(table);
  body.appendChild(wrap);
}

function reportLabel(report: Report): string {
  const name = report.meta?.username || "Unknown";
  const date = String(report.meta?.generated_at || "").slice(0, 10);
  return date ? `${name} · ${date}` : name;
}

function numberDelta(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (Number.isNaN(Number(a)) || Number.isNaN(Number(b))) return null;
  return Number(b) - Number(a);
}

function signed(value: number | null, digits: number): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 0.0001) return "0";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
