import type { Report } from "./types";

const CSV_HEADERS = [
  "date",
  "game_id",
  "url",
  "color",
  "opponent",
  "opponent_rating",
  "result",
  "speed",
  "time_control",
  "opening",
  "moves",
  "analyzed_moves",
  "acpl",
  "accuracy",
  "top_match",
  "blunders",
  "fast_accuracy",
  "suspicion",
  "flags",
];

function safeName(name: unknown): string {
  return String(name || "player")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 40);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reportToCsv(report: Report): string {
  const rows = (report.games || []).map((game) =>
    [
      game.date,
      game.game_id,
      game.url,
      game.color,
      game.opponent,
      game.opponent_rating,
      game.result,
      game.speed,
      game.time_control,
      game.opening,
      game.moves_count,
      game.analyzed_moves,
      game.acpl,
      game.accuracy,
      game.top_match,
      game.blunders,
      game.fast_accuracy,
      game.suspicion,
      (game.flags || []).join("|"),
    ]
      .map((value) => {
        const text = value === null || value === undefined ? "" : String(value);
        return `"${text.replace(/"/g, '""')}"`;
      })
      .join(","),
  );
  return [CSV_HEADERS.join(","), ...rows].join("\n");
}

export function downloadJson(report: Report): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  downloadBlob(blob, `knightwatch-${safeName(report.meta?.username)}.json`);
}

export function downloadCsv(report: Report): void {
  const blob = new Blob([reportToCsv(report)], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `knightwatch-${safeName(report.meta?.username)}.csv`);
}
