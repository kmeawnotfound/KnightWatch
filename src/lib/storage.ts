import { del, get, set } from "idb-keyval";

import type { Report } from "./types";

const REPORT_PREFIX = "knightwatch:report:";
const INDEX_KEY = "knightwatch:report-index";

export interface StoredReportInfo {
  id: string;
  username: string;
  score: number;
  verdict: string;
  confidence_label: string;
  games: number;
  generated_at: string;
  saved_at: string;
}

function reportKey(id: string): string {
  return `${REPORT_PREFIX}${id}`;
}

async function readIndex(): Promise<StoredReportInfo[]> {
  try {
    const value = await get<StoredReportInfo[]>(INDEX_KEY);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function writeIndex(entries: StoredReportInfo[]): Promise<void> {
  try {
    await set(INDEX_KEY, entries.slice(0, 100));
  } catch {
    /* IndexedDB may be unavailable in private mode */
  }
}

export async function saveReport(id: string, report: Report): Promise<void> {
  try {
    await set(reportKey(id), report);
  } catch {
    return;
  }
  const summary = report.summary || ({} as Report["summary"]);
  const metrics = summary.metrics || {};
  const info: StoredReportInfo = {
    id,
    username: String(report.meta?.username || "Unknown"),
    score: Number(summary.score || 0),
    verdict: String(summary.verdict || ""),
    confidence_label: String(summary.confidence_label || ""),
    games: Number(metrics.games || 0),
    generated_at: String(report.meta?.generated_at || ""),
    saved_at: new Date().toISOString(),
  };
  const entries = (await readIndex()).filter((entry) => entry.id !== id);
  entries.unshift(info);
  await writeIndex(entries);
}

export async function loadReport(id: string): Promise<Report | null> {
  try {
    const report = await get<Report>(reportKey(id));
    return report || null;
  } catch {
    return null;
  }
}

export async function listReports(): Promise<StoredReportInfo[]> {
  return readIndex();
}

export async function deleteReport(id: string): Promise<void> {
  try {
    await del(reportKey(id));
  } catch {
    /* ignore */
  }
  const entries = (await readIndex()).filter((entry) => entry.id !== id);
  await writeIndex(entries);
}
