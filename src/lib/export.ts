import { criticalErrors } from "./highlights";
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

export function downloadHtml(report: Report): void {
  const blob = new Blob([reportToHtml(report)], { type: "text/html;charset=utf-8" });
  downloadBlob(blob, `knightwatch-${safeName(report.meta?.username)}.html`);
}

// ---------------------------------------------------------------------------
// Self-contained HTML report
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreColor(score: number): string {
  if (score < 30) return "#57d38c";
  if (score < 45) return "#a3d977";
  if (score < 60) return "#f5b84c";
  if (score < 75) return "#f08c4c";
  if (score < 88) return "#ff6b6b";
  return "#e5484d";
}

function fixed(value: unknown, digits: number): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function integer(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return String(Math.round(Number(value)));
}

function sourceLabel(source: unknown): string {
  if (source === "pgn") return "PGN import";
  if (source === "demo") return "Demo report";
  if (source === "chesscom") return "Chess.com";
  return "Lichess";
}

export function reportToHtml(report: Report): string {
  const meta = report.meta || {};
  const summary = report.summary;
  const metrics = summary.metrics || {};
  const games = report.games || [];
  const score = Math.max(0, Math.min(100, Number(summary.score) || 0));
  const color = scoreColor(score);
  const name = meta.username || "Player";
  const generated = String(meta.generated_at || "").replace("T", " ").replace("+00:00", " UTC");
  const dateRange =
    meta.date_min && meta.date_max ? `${meta.date_min} → ${meta.date_max}` : "date range unknown";

  const cards: Array<[string, string]> = [
    ["Avg. centipawn loss", fixed(metrics.acpl, 1)],
    ["Accuracy", metrics.accuracy === null || metrics.accuracy === undefined ? "—" : `${fixed(metrics.accuracy, 1)}%`],
    ["Top-move match", metrics.top_match === null || metrics.top_match === undefined ? "—" : `${fixed(metrics.top_match, 1)}%`],
    [
      "Fast-move accuracy",
      metrics.fast_accuracy === null || metrics.fast_accuracy === undefined
        ? "—"
        : `${fixed(metrics.fast_accuracy, 1)}%`,
    ],
    ["Performance", integer(metrics.performance)],
    ["Games analysed", integer(metrics.games_analyzed || metrics.games || 0)],
  ];

  const reasons = (summary.reasons || [])
    .map(
      (reason) =>
        `<li class="reason ${esc(reason.severity || "info")}"><strong>${esc(reason.title)}</strong><span>${esc(reason.detail)}</span></li>`,
    )
    .join("");

  const moments = criticalErrors(report, 8)
    .map(
      ({ game, move }) => {
        const number = move.move_no || Math.ceil(move.ply / 2);
        return `<tr><td>${esc(game.opponent)}<small>${esc(game.date)}</small></td><td class="mono">${number}${move.color === "white" ? "." : "..."} ${esc(move.san)}</td><td class="mono">−${fixed(move.loss_cp ?? 0, 0)} cp</td><td class="mono">${esc(move.best_san || "—")}</td></tr>`;
      },
    )
    .join("");

  const gameRows = games
    .map((game) => {
      const signal = Math.round(Number(game.suspicion) || 0);
      return `<tr>
        <td class="mono">${esc(game.date)}</td>
        <td>${esc(game.opponent)}</td>
        <td>${game.color === "white" ? "W" : "B"}</td>
        <td>${esc(game.result)}</td>
        <td class="mono">${esc(game.player_rating ?? "—")}</td>
        <td class="mono">${fixed(game.acpl, 1)}</td>
        <td class="mono">${game.accuracy === null || game.accuracy === undefined ? "—" : `${fixed(game.accuracy, 1)}%`}</td>
        <td class="mono" style="color:${scoreColor(signal)};font-weight:700">${signal}</td>
      </tr>`;
    })
    .join("");

  const notes = (summary.notes || []).map((note) => `<li>${esc(note)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="KnightWatch" />
<title>KnightWatch report — ${esc(name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #080c11; color: #e8eef5; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .wrap { width: min(1100px, calc(100% - 40px)); margin: 0 auto; padding: 34px 0 50px; }
  header { border-bottom: 1px solid #1e2b3a; padding-bottom: 18px; margin-bottom: 24px; }
  .brand { color: #f0c674; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  h1 { margin: 8px 0 4px; font-size: 30px; letter-spacing: -.01em; }
  .sub { color: #8fa0b5; font-size: 13px; }
  .hero { display: flex; align-items: center; gap: 26px; padding: 20px; border: 1px solid #1e2b3a; border-radius: 16px; background: #111923; margin-bottom: 18px; }
  .score { width: 132px; height: 132px; border-radius: 50%; border: 10px solid ${color}; display: grid; place-items: center; flex: 0 0 auto; box-shadow: 0 0 30px ${color}33; }
  .score b { font: 800 40px/1 ui-monospace, Consolas, monospace; color: ${color}; }
  .score span { color: #65758a; font-size: 12px; }
  .verdict { font-size: 20px; font-weight: 750; color: ${color}; }
  .cards { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 18px; }
  .card { border: 1px solid #172230; border-radius: 11px; background: #0f1720; padding: 12px; }
  .card span { display: block; color: #65758a; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .card b { display: block; margin-top: 4px; font: 700 20px/1.2 ui-monospace, Consolas, monospace; }
  section { border: 1px solid #1e2b3a; border-radius: 16px; background: #111923; padding: 20px; margin-bottom: 18px; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .reason { border-left: 3px solid #65758a; background: #0a1017; border-radius: 9px; padding: 10px 12px; }
  .reason strong { display: block; font-size: 13px; }
  .reason span { color: #8fa0b5; font-size: 12.5px; }
  .reason.high { border-left-color: #ff6b6b; }
  .reason.medium { border-left-color: #f5b84c; }
  .reason.low { border-left-color: #4fd1c5; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; padding: 8px 10px; color: #65758a; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; border-bottom: 1px solid #1e2b3a; }
  td { padding: 8px 10px; border-bottom: 1px solid #172230; }
  td small { display: block; color: #65758a; font-size: 10px; }
  .mono { font-family: ui-monospace, Consolas, monospace; }
  .disclaimer { color: #65758a; font-size: 11.5px; line-height: 1.7; text-align: center; margin: 22px auto 0; max-width: 820px; }
  footer { margin-top: 26px; padding-top: 16px; border-top: 1px solid #172230; color: #65758a; font-size: 11px; text-align: center; }
  @media (max-width: 820px) { .cards { grid-template-columns: repeat(2, 1fr); } .hero { flex-direction: column; align-items: flex-start; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">KnightWatch</div>
    <h1>${esc(name)}</h1>
    <div class="sub">${esc(sourceLabel(meta.source))} · ${esc(dateRange)} · ${esc(games.length)} game${games.length === 1 ? "" : "s"} · generated ${esc(generated)}</div>
  </header>

  <div class="hero">
    <div class="score"><b>${Math.round(score)}</b><span>/ 100</span></div>
    <div>
      <div class="verdict">${esc(summary.verdict || "—")}</div>
      <div class="sub">Confidence ${esc(summary.confidence_label || "—")} · ${Math.round((summary.confidence || 0) * 100)}% · statistical signal, not proof.</div>
    </div>
  </div>

  <div class="cards">
    ${cards.map(([label, value]) => `<div class="card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
  </div>

  <section>
    <h2>Why this score?</h2>
    <ul>${reasons || "<li>No reasons recorded.</li>"}</ul>
    ${notes ? `<ul style="margin-top:12px">${notes}</ul>` : ""}
  </section>

  ${moments ? `<section><h2>Costly decisions</h2><table><thead><tr><th>Game</th><th>Move</th><th>Loss</th><th>Engine best</th></tr></thead><tbody>${moments}</tbody></table></section>` : ""}

  <section>
    <h2>Games</h2>
    <table>
      <thead><tr><th>Date</th><th>Opponent</th><th>Col.</th><th>Result</th><th>Rating</th><th>ACPL</th><th>Accuracy</th><th>Signal</th></tr></thead>
      <tbody>${gameRows || `<tr><td colspan="8">No games in this report.</td></tr>`}</tbody>
    </table>
  </section>

  <p class="disclaimer">${esc(meta.disclaimer || "Statistical screening only — not proof of cheating.")} This report was generated entirely in a browser by KnightWatch. Scores are heuristics and can be affected by sample size, time control, and opponent strength. Review the games and context before drawing conclusions.</p>

  <footer>Generated by KnightWatch · client-side fair-play screening · not affiliated with Lichess or Chess.com</footer>
</div>
</body>
</html>`;
}
