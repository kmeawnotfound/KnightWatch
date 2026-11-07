import type { Report } from "../lib/types";
import { drawGameChart } from "./chart";
import { renderCritical } from "./critical";
import { $, byId, clearNode, el, setText } from "./dom";
import { els } from "./els";
import { fmtInt, fmtNumber, fmtPct, scoreColor } from "./format";
import { populateSpeedFilter, renderGames } from "./games";
import { renderTiming } from "./timing";
import { state } from "./state";

export function renderReport(report: Report): void {
  state.report = report;
  state.finished = true;
  els.results.classList.remove("hidden");
  els.progressPanel.classList.add("hidden");
  document.getElementById("error-banner")?.classList.add("hidden");

  const meta = report.meta || {};
  const summary = report.summary;
  const metrics = summary.metrics || {};
  const profile = (report.profile || {}) as Record<string, any>;

  const title = meta.username || profile.username || "Player report";
  setText(byId("report-title"), String(title));
  const speedText = Object.entries(meta.speeds || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([speed, count]) => `${speed} ×${count}`)
    .join(" · ");
  const dateRange =
    meta.date_min && meta.date_max ? `${meta.date_min} → ${meta.date_max}` : "date range unknown";
  setText(
    byId("report-subtitle"),
    `${metrics.games || 0} game${Number(metrics.games) === 1 ? "" : "s"} · ${dateRange} · ${speedText || "mixed time controls"}`,
  );

  if (meta.demo_label) {
    els.demoBanner.textContent = `Demo report — ${meta.demo_label}`;
    els.demoBanner.classList.remove("hidden");
  } else {
    els.demoBanner.classList.add("hidden");
  }

  renderGauge(summary);
  renderMetrics(metrics);
  renderMeta(meta, profile, metrics);
  renderReasons(summary);
  drawGameChart(byId<SVGSVGElement>("game-chart"), report.games || []);
  renderCritical();
  renderTiming();
  populateSpeedFilter(report.games || []);
  renderGames();
  setText(byId("disclaimer"), meta.disclaimer || "Statistical screening only — not proof of cheating.");

  els.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderGauge(summary: Report["summary"]): void {
  const score = Math.max(0, Math.min(100, Number(summary.score) || 0));
  const color = scoreColor(score);
  const card = $(".gauge-card");
  card.style.setProperty("--gauge-color", color);
  const circle = byId<SVGCircleElement>("gauge-value");
  circle.style.strokeDashoffset = `${439.82 * (1 - score / 100)}`;
  setText(byId("gauge-score"), String(score));
  setText(byId("verdict"), summary.verdict || "—");
  setText(
    byId("confidence"),
    `Confidence ${summary.confidence_label || "—"} · ${Math.round((summary.confidence || 0) * 100)}%`,
  );
}

function metricCard(label: string, value: string, sub: string, valueClass = ""): HTMLElement {
  const card = el("div", "metric");
  card.appendChild(el("span", "metric-label", label));
  const valueNode = el("span", `metric-value ${valueClass}`.trim(), value);
  card.appendChild(valueNode);
  if (sub) card.appendChild(el("span", "metric-sub", sub));
  return card;
}

function renderMetrics(metrics: Record<string, any>): void {
  const grid = byId("metric-grid");
  clearNode(grid);
  const acpl = metrics.acpl;
  const expectedAcpl = metrics.expected_acpl;
  grid.appendChild(
    metricCard(
      "Avg. centipawn loss",
      acpl === null || acpl === undefined ? "—" : fmtNumber(acpl, 1),
      expectedAcpl ? `expected ~${fmtNumber(expectedAcpl, 0)}` : "no engine data",
    ),
  );
  grid.appendChild(
    metricCard(
      "Accuracy",
      fmtPct(metrics.accuracy, 1),
      metrics.expected_accuracy ? `expected ~${fmtPct(metrics.expected_accuracy, 0)}` : "",
    ),
  );
  grid.appendChild(
    metricCard(
      "Top-move match",
      metrics.top_match === null || metrics.top_match === undefined ? "—" : fmtPct(metrics.top_match, 1),
      metrics.top_match === null || metrics.top_match === undefined
        ? "local engine only"
        : `expected ~${fmtPct(metrics.expected_top_match, 0)}`,
    ),
  );
  grid.appendChild(
    metricCard(
      "Fast-move accuracy",
      metrics.fast_accuracy === null || metrics.fast_accuracy === undefined
        ? "—"
        : fmtPct(metrics.fast_accuracy, 1),
      metrics.slow_accuracy !== null && metrics.slow_accuracy !== undefined
        ? `slower moves ${fmtPct(metrics.slow_accuracy, 1)}`
        : `${fmtInt(metrics.fast_moves)} fast moves`,
    ),
  );
  grid.appendChild(
    metricCard(
      "Performance",
      metrics.performance === null || metrics.performance === undefined
        ? "—"
        : fmtInt(metrics.performance),
      metrics.avg_rating ? `own rating ${fmtInt(metrics.avg_rating)}` : "",
    ),
  );
  grid.appendChild(
    metricCard(
      "Games analysed",
      fmtInt(metrics.games_analyzed || metrics.games || 0),
      `${fmtInt(metrics.analyzed_moves || 0)} moves evaluated`,
    ),
  );
}

function renderMeta(
  meta: Record<string, any>,
  profile: Record<string, any>,
  metrics: Record<string, any>,
): void {
  const list = byId("meta-list");
  clearNode(list);
  const rows: Array<[string, string]> = [
    ["Player", profile.username || meta.username || "—"],
    [
      "Source",
      meta.source === "pgn"
        ? "PGN import"
        : meta.source === "demo"
          ? "Demo report"
          : meta.source === "chesscom"
            ? "Chess.com"
            : "Lichess",
    ],
    ["Engine", engineLabel(meta.engine_mode, meta.engine_depth, meta.analysis_sources)],
    ["Games", `${fmtInt(meta.games_total)} total · ${fmtInt(meta.games_analyzed)} with engine data`],
    ["Moves", `${fmtInt(meta.moves_analyzed)} analysed · ${fmtInt(meta.timed_moves)} with clocks`],
    ["Avg. rating", fmtInt(meta.avg_rating)],
    ["Generated", String(meta.generated_at || "").replace("T", " ").replace("+00:00", " UTC")],
  ];
  rows.forEach(([key, value]) => {
    list.appendChild(el("dt", null, key));
    const dd = el("dd", null, value);
    if (key === "Player" && profile.url) {
      clearNode(dd);
      const link = el("a", null, value);
      link.href = String(profile.url);
      link.target = "_blank";
      link.rel = "noreferrer";
      dd.appendChild(link);
    }
    list.appendChild(dd);
  });

  const coverage = byId("coverage-bars");
  clearNode(coverage);
  const items: Array<[string, number, string]> = [
    ["Engine coverage", meta.engine_coverage, `${Math.round((meta.engine_coverage || 0) * 100)}% of games`],
    ["Clock coverage", meta.time_coverage, `${Math.round((meta.time_coverage || 0) * 100)}% of moves`],
  ];
  items.forEach(([label, value, text]) => {
    const item = el("div", "coverage-item");
    const head = el("div", "coverage-label");
    head.appendChild(el("span", null, label));
    head.appendChild(el("span", null, text));
    item.appendChild(head);
    const track = el("div", "coverage-track");
    const fill = el("div", "coverage-fill");
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
    track.appendChild(fill);
    item.appendChild(track);
    coverage.appendChild(item);
  });
}

function engineLabel(mode: unknown, depth: unknown, sources: unknown): string {
  const counts = (sources || {}) as Record<string, unknown>;
  const lichess = Number(counts.lichess || 0);
  const local = Number(counts.stockfish || 0);
  if (mode === "stockfish" && lichess > 0 && local > 0) {
    return `Local Stockfish · depth ${depth || "?"} + Lichess analysis (${fmtInt(lichess)} games)`;
  }
  if (mode === "stockfish") return `Local Stockfish · depth ${depth || "?"}`;
  if (mode === "cloud") return "Lichess cloud eval";
  if (mode === "lichess") return "Existing Lichess analysis";
  if (mode === "pgn") return "PGN annotations + engine";
  return "Mixed / auto";
}

function renderReasons(summary: Report["summary"]): void {
  const container = byId("reasons");
  clearNode(container);
  const reasons = summary.reasons || [];
  if (!reasons.length) {
    reasons.push({
      severity: "info",
      title: "No strong statistical outliers",
      detail: "The screen did not find any large anomaly in the selected metrics.",
    });
  }
  reasons.forEach((reason) => {
    const node = el("div", `reason ${reason.severity || "info"}`);
    const icon = el(
      "div",
      "reason-icon",
      reason.severity === "high"
        ? "!"
        : reason.severity === "medium"
          ? "~"
          : reason.severity === "low"
            ? "↑"
            : "i",
    );
    const body = el("div");
    body.appendChild(el("div", "reason-title", reason.title || "Signal"));
    body.appendChild(el("div", "reason-detail", reason.detail || ""));
    node.appendChild(icon);
    node.appendChild(body);
    container.appendChild(node);
  });

  const components = summary.components || [];
  const strongest = components
    .slice(0, 3)
    .map((component) => `${component.label} (z ${component.z > 0 ? "+" : ""}${component.z})`);
  setText(
    byId("reasons-sub"),
    strongest.length
      ? `Largest deviations: ${strongest.join(" · ")}`
      : "Not enough data for component scores",
  );

  const notes = byId("notes");
  clearNode(notes);
  (summary.notes || []).forEach((note) => notes.appendChild(el("div", "note", note)));
}
