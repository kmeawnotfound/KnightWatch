import { downloadCsv, downloadHtml, downloadJson } from "../lib/export.js";
import { saveReport } from "../lib/storage.js";
import type { Report } from "../lib/types";
import { toast } from "./notify";
import { renderReport } from "./report";
import { state } from "./state";

export function exportJson(): void {
  if (!state.report) return;
  downloadJson(state.report);
}

export function exportCsv(): void {
  if (!state.report) return;
  downloadCsv(state.report);
}

export function exportHtml(): void {
  if (!state.report) return;
  downloadHtml(state.report);
}

export async function importJson(file: File): Promise<void> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!isReport(parsed)) {
      throw new Error("That file does not look like a KnightWatch report.");
    }
    const id = `import-${Date.now().toString(36)}`;
    await saveReport(id, parsed);
    state.jobId = id;
    state.demo = false;
    renderReport(parsed);
    window.history.replaceState(null, "", `?job=${encodeURIComponent(id)}`);
    toast("Report imported and saved to this browser");
  } catch (error) {
    toast((error as Error).message || "Could not import that file.", true);
  }
}

function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<Report>;
  return Boolean(report.meta && report.summary && Array.isArray(report.games));
}
