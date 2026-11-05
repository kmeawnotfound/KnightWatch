(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    jobId: null,
    pollTimer: null,
    pollErrors: 0,
    report: null,
    demo: false,
    sortKey: "suspicion",
    sortDir: "desc",
    filters: { result: "all", color: "all", speed: "all" },
    ai: { available: false, models: [] },
    tokenConfigured: false,
    lastLogCount: -1,
    finished: false,
  };

  const els = {
    enginePill: $("#engine-pill"),
    enginePillText: $("#engine-pill-text"),
    scanForm: $("#scan-form"),
    pgnForm: $("#pgn-form"),
    scanSubmit: $("#scan-submit"),
    pgnSubmit: $("#pgn-submit"),
    progressPanel: $("#progress-panel"),
    progressPhase: $("#progress-phase"),
    progressTitle: $("#progress-title"),
    progressPercent: $("#progress-percent"),
    progressFill: $("#progress-fill"),
    progressCounts: $("#progress-counts"),
    progressEta: $("#progress-eta"),
    logList: $("#log-list"),
    cancelJob: $("#cancel-job"),
    results: $("#results"),
    demoBanner: $("#demo-banner"),
    errorBanner: $("#error-banner"),
    errorTitle: $("#error-title"),
    errorText: $("#error-text"),
    toast: $("#toast"),
    gameModal: $("#game-modal"),
    aiCard: $("#ai-card"),
    aiModel: $("#ai-model"),
    aiOutput: $("#ai-output"),
    aiRun: $("#ai-run"),
  };

  // ------------------------------------------------------------------ utils

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtInt(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Math.round(Number(value)).toLocaleString();
  }

  function fmtPct(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return `${Number(value).toFixed(digits)}%`;
  }

  function fmtPawns(cp) {
    if (cp === null || cp === undefined) return "—";
    const pawns = cp / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }

  function fmtTime(seconds) {
    if (seconds === null || seconds === undefined) return "";
    const s = Number(seconds);
    if (s < 1) return `${Math.round(s * 1000)}ms`;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${m}m ${rem.toString().padStart(2, "0")}s`;
  }

  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined) return "";
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toString().padStart(2, "0")}s`;
  }

  function scoreColor(score) {
    if (score < 30) return "#57d38c";
    if (score < 45) return "#a3d977";
    if (score < 60) return "#f5b84c";
    if (score < 75) return "#f08c4c";
    if (score < 88) return "#ff6b6b";
    return "#e5484d";
  }

  function scoreClass(score) {
    if (score < 45) return "good";
    if (score < 70) return "warn";
    return "bad";
  }

  function titleCase(value) {
    if (!value) return "—";
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  // -------------------------------------------------------------------- API

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* non-JSON response */
    }
    if (!response.ok) {
      const detail = data && data.detail;
      let message = `Request failed (${response.status})`;
      let hint = null;
      if (typeof detail === "string") {
        message = detail;
      } else if (Array.isArray(detail) && detail.length) {
        const first = detail[0] || {};
        const field = Array.isArray(first.loc) ? first.loc.filter((part) => part !== "body").join(".") : "";
        message = `${field ? `${field}: ` : ""}${first.msg || "Invalid request"}`;
      } else if (detail && typeof detail === "object") {
        message = detail.message || message;
        hint = detail.hint || null;
      } else if (data && data.message) {
        message = data.message;
      }
      const error = new Error(message);
      error.hint = hint;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function clearJobParam() {
    if (window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  function showError(error, title = "Something went wrong") {
    setText(els.errorTitle, title);
    setText(els.errorText, error && error.message ? error.message : String(error));
    if (error && error.hint) {
      els.errorText.textContent += ` ${error.hint}`;
    }
    els.errorBanner.classList.remove("hidden");
    els.errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function clearError() {
    els.errorBanner.classList.add("hidden");
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 4200);
  }

  // ------------------------------------------------------------------- init

  async function init() {
    bindEvents();
    try {
      const health = await api("/api/health");
      state.tokenConfigured = !!health.token_configured;
      if (health.stockfish && health.stockfish.available) {
        els.enginePill.classList.add("ok");
        const sf = health.stockfish;
        const detail =
          sf.workers && sf.threads
            ? ` · ${sf.workers}×${sf.threads}T · ${sf.hash_mb || "?"} MB`
            : "";
        setText(els.enginePillText, `Local Stockfish ready${detail}`);
      } else {
        els.enginePill.classList.add("warn");
        setText(els.enginePillText, "Cloud evaluation only");
      }
    } catch (_) {
      els.enginePill.classList.add("warn");
      setText(els.enginePillText, "Server unavailable");
    }
    try {
      state.ai = await api("/api/ai/status");
      if (state.ai.available && state.ai.models.length) {
        state.ai.models.forEach((name) => {
          const option = el("option", null, name);
          option.value = name;
          els.aiModel.appendChild(option);
        });
        els.aiCard.classList.remove("hidden");
      }
    } catch (_) {
      state.ai = { available: false, models: [] };
    }

    const jobId = new URLSearchParams(window.location.search).get("job");
    if (jobId) await loadJobReport(jobId);
  }

  async function loadJobReport(jobId) {
    stopPolling();
    state.jobId = jobId;
    state.demo = false;
    state.finished = true;
    try {
      const report = await api(`/api/jobs/${encodeURIComponent(jobId)}/report`);
      renderReport(report);
      toast("Saved report loaded");
    } catch (error) {
      showError(error, "Report unavailable");
    }
  }

  function bindEvents() {
    $("#tab-lichess").addEventListener("click", () => setTab("lichess"));
    $("#tab-pgn").addEventListener("click", () => setTab("pgn"));
    $("#tab-demo").addEventListener("click", () => setTab("demo"));

    els.scanForm.addEventListener("submit", submitScan);
    els.pgnForm.addEventListener("submit", submitPgn);
    $("#toggle-token").addEventListener("click", toggleToken);
    $("#check-token").addEventListener("click", checkToken);
    $("#error-close").addEventListener("click", clearError);
    els.cancelJob.addEventListener("click", cancelJob);
    $("#new-scan").addEventListener("click", newScan);
    $("#export-json").addEventListener("click", exportJson);
    $("#export-csv").addEventListener("click", exportCsv);
    $("#demo-clean").addEventListener("click", () => loadDemo("clean"));
    $("#demo-suspect").addEventListener("click", () => loadDemo("suspect"));

    $("#filter-result").addEventListener("change", (event) => {
      state.filters.result = event.target.value;
      renderGames();
    });
    $("#filter-color").addEventListener("change", (event) => {
      state.filters.color = event.target.value;
      renderGames();
    });
    $("#filter-speed").addEventListener("change", (event) => {
      state.filters.speed = event.target.value;
      renderGames();
    });

    $$(".games-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        } else {
          state.sortKey = key;
          state.sortDir = key === "date" ? "desc" : "desc";
        }
        $$(".games-table th").forEach((node) => node.classList.remove("sorted", "asc"));
        th.classList.add("sorted");
        if (state.sortDir === "asc") th.classList.add("asc");
        renderGames();
      });
    });

    $("#modal-close").addEventListener("click", closeModal);
    $$("[data-close]").forEach((node) => node.addEventListener("click", closeModal));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
    });

    els.aiRun.addEventListener("click", runAiSummary);
  }

  function setTab(name) {
    const mapping = {
      lichess: ["#tab-lichess", "#pane-lichess"],
      pgn: ["#tab-pgn", "#pane-pgn"],
      demo: ["#tab-demo", "#pane-demo"],
    };
    Object.entries(mapping).forEach(([key, [tab, pane]]) => {
      $(tab).classList.toggle("active", key === name);
      $(tab).setAttribute("aria-selected", key === name ? "true" : "false");
      $(pane).classList.toggle("active", key === name);
    });
  }

  function toggleToken() {
    const input = $("#token");
    const button = $("#toggle-token");
    if (input.type === "password") {
      input.type = "text";
      button.textContent = "Hide";
    } else {
      input.type = "password";
      button.textContent = "Show";
    }
  }

  async function checkToken() {
    const token = $("#token").value.trim();
    const status = $("#token-status");
    if (!token) {
      status.textContent = "Paste a token first.";
      status.style.color = "var(--amber)";
      return;
    }
    const button = $("#check-token");
    button.disabled = true;
    status.textContent = "Checking…";
    status.style.color = "var(--muted)";
    try {
      const data = await api("/api/token/check", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      const name = data.account && data.account.username ? data.account.username : "account";
      status.textContent = `Connected as ${name}.`;
      status.style.color = "var(--green)";
      toast(`Token works — ${name}`);
    } catch (error) {
      status.textContent = error.message + (error.hint ? ` ${error.hint}` : "");
      status.style.color = "var(--red)";
    } finally {
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------------- scan

  async function submitScan(event) {
    event.preventDefault();
    clearError();
    const username = $("#username").value.trim();
    const token = $("#token").value.trim();
    if (!username) {
      showError({ message: "Enter a Lichess username." }, "Missing username");
      return;
    }
    if (!token && !state.tokenConfigured) {
      showError(
        {
          message: "A Lichess personal API token is required to download the full game history.",
          hint: "Create a free token at https://lichess.org/account/oauth/token (no scopes needed), then paste it above.",
        },
        "Token required"
      );
      return;
    }
    const payload = {
      username,
      token: token || null,
      perf: $("#perf").value,
      max_games: Number($("#max-games").value),
      include_unrated: $("#include-unrated").checked,
      engine: $("#engine").value,
      depth: Number($("#depth").value),
      samples: Number($("#samples").value),
      reanalyze: $("#reanalyze").checked,
    };
    await startJob("/api/scan", payload, els.scanSubmit);
  }

  async function submitPgn(event) {
    event.preventDefault();
    clearError();
    const pgn = $("#pgn-text").value.trim();
    if (!pgn) {
      showError({ message: "Paste a PGN first." }, "Missing PGN");
      return;
    }
    const payload = {
      pgn,
      player: $("#pgn-player").value.trim() || null,
      max_games: Number($("#pgn-max").value),
      engine: $("#pgn-engine").value,
      depth: Number($("#pgn-depth").value),
      samples: Number($("#pgn-samples").value),
    };
    await startJob("/api/import/pgn", payload, els.pgnSubmit);
  }

  async function startJob(path, payload, button) {
    clearJobParam();
    state.demo = false;
    state.finished = false;
    state.pollErrors = 0;
    state.lastLogCount = -1;
    els.results.classList.add("hidden");
    els.progressPanel.classList.remove("hidden");
    els.progressPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    button.disabled = true;
    setProgress({ percent: 0, phase: "queued" }, "Queued", "Waiting for a free slot…");
    try {
      const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
      state.jobId = data.job_id;
      state.finished = false;
      pollJob();
      state.pollTimer = setInterval(pollJob, 850);
    } catch (error) {
      button.disabled = false;
      els.progressPanel.classList.add("hidden");
      showError(error, "Could not start scan");
    }
  }

  async function pollJob() {
    if (!state.jobId || state.finished) return;
    try {
      const job = await api(`/api/jobs/${state.jobId}`);
      state.pollErrors = 0;
      updateProgress(job);
      if (job.status === "done") {
        state.finished = true;
        stopPolling();
        els.scanSubmit.disabled = false;
        els.pgnSubmit.disabled = false;
        try {
          const report = await api(`/api/jobs/${state.jobId}/report`);
          renderReport(report);
        } catch (error) {
          showError(error, "Report could not be loaded");
        }
      } else if (job.status === "error") {
        state.finished = true;
        stopPolling();
        els.scanSubmit.disabled = false;
        els.pgnSubmit.disabled = false;
        showError({ message: job.error, hint: job.error_hint }, "Scan failed");
      } else if (job.status === "cancelled") {
        state.finished = true;
        stopPolling();
        els.scanSubmit.disabled = false;
        els.pgnSubmit.disabled = false;
        els.progressPanel.classList.add("hidden");
        toast("Scan cancelled");
      }
    } catch (error) {
      state.pollErrors += 1;
      if (state.pollErrors >= 5) {
        stopPolling();
        els.scanSubmit.disabled = false;
        els.pgnSubmit.disabled = false;
        showError(error, "Lost connection to the server");
      }
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  const phaseLabels = {
    queued: "Queued",
    profile: "Profile",
    fetching: "Downloading",
    parsing: "Parsing",
    analyzing: "Analysing",
    scoring: "Scoring",
    done: "Complete",
    error: "Error",
    cancelled: "Cancelled",
  };

  function setProgress(progress, phase, title) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    els.progressPhase.textContent = phaseLabels[phase] || titleCase(phase || "working");
    els.progressTitle.textContent = title;
    els.progressPercent.textContent = `${Math.round(percent)}%`;
    els.progressFill.style.width = `${percent}%`;
  }

  function updateProgress(job) {
    const progress = job.progress || {};
    const phase = job.phase || job.status;
    const percent = progress.percent || 0;
    let title = "Working…";
    if (phase === "queued") title = "Waiting for a free analysis slot…";
    else if (phase === "profile") title = "Loading the Lichess profile…";
    else if (phase === "fetching") title = "Downloading games from Lichess…";
    else if (phase === "parsing") title = "Parsing PGN…";
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

  async function cancelJob() {
    if (!state.jobId) return;
    try {
      await api(`/api/jobs/${state.jobId}/cancel`, { method: "POST" });
      toast("Cancellation requested");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function newScan() {
    clearJobParam();
    stopPolling();
    state.jobId = null;
    state.report = null;
    state.demo = false;
    state.finished = false;
    els.results.classList.add("hidden");
    els.progressPanel.classList.add("hidden");
    els.scanSubmit.disabled = false;
    els.pgnSubmit.disabled = false;
    clearError();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------------------- demo

  async function loadDemo(kind) {
    clearJobParam();
    clearError();
    stopPolling();
    state.jobId = null;
    state.demo = true;
    state.finished = true;
    try {
      const report = await api(`/api/demo/${kind}`);
      els.progressPanel.classList.add("hidden");
      renderReport(report);
      toast(kind === "suspect" ? "Synthetic suspect demo loaded" : "Clean GM demo loaded");
    } catch (error) {
      showError(error, "Demo unavailable");
    }
  }

  // ----------------------------------------------------------------- report

  function renderReport(report) {
    state.report = report;
    state.finished = true;
    els.results.classList.remove("hidden");
    els.progressPanel.classList.add("hidden");
    clearError();

    const meta = report.meta || {};
    const summary = report.summary || {};
    const metrics = summary.metrics || {};
    const profile = report.profile || {};

    const title = meta.username || profile.username || "Player report";
    setText($("#report-title"), `${title}`);
    const speedText = Object.entries(meta.speeds || {})
      .sort((a, b) => b[1] - a[1])
      .map(([speed, count]) => `${speed} ×${count}`)
      .join(" · ");
    const dateRange = meta.date_min && meta.date_max ? `${meta.date_min} → ${meta.date_max}` : "date range unknown";
    setText(
      $("#report-subtitle"),
      `${metrics.games || 0} game${Number(metrics.games) === 1 ? "" : "s"} · ${dateRange} · ${speedText || "mixed time controls"}`
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
    drawGameChart(report.games || []);
    populateSpeedFilter(report.games || []);
    renderGames();
    setText($("#disclaimer"), meta.disclaimer || "Statistical screening only — not proof of cheating.");

    const aiAvailable = state.ai.available && state.ai.models.length > 0;
    els.aiCard.classList.toggle("hidden", !aiAvailable);
    els.aiRun.disabled = state.demo || !state.jobId;
    els.aiRun.title = state.demo ? "AI summary is available for live scans" : "";
    els.aiOutput.textContent = "No summary generated yet.";
    els.aiOutput.classList.remove("loading");

    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderGauge(summary) {
    const score = Math.max(0, Math.min(100, Number(summary.score) || 0));
    const color = scoreColor(score);
    const card = $(".gauge-card");
    card.style.setProperty("--gauge-color", color);
    const circle = $("#gauge-value");
    circle.style.strokeDashoffset = `${439.82 * (1 - score / 100)}`;
    setText($("#gauge-score"), String(score));
    setText($("#verdict"), summary.verdict || "—");
    setText($("#confidence"), `Confidence ${summary.confidence_label || "—"} · ${Math.round((summary.confidence || 0) * 100)}%`);
  }

  function metricCard(label, value, sub, valueClass = "") {
    const card = el("div", "metric");
    card.appendChild(el("span", "metric-label", label));
    const valueNode = el("span", `metric-value ${valueClass}`.trim(), value);
    card.appendChild(valueNode);
    if (sub) card.appendChild(el("span", "metric-sub", sub));
    return card;
  }

  function renderMetrics(metrics) {
    const grid = $("#metric-grid");
    clearNode(grid);
    const acpl = metrics.acpl;
    const expectedAcpl = metrics.expected_acpl;
    grid.appendChild(
      metricCard(
        "Avg. centipawn loss",
        acpl === null || acpl === undefined ? "—" : fmtNumber(acpl, 1),
        expectedAcpl ? `expected ~${fmtNumber(expectedAcpl, 0)}` : "no engine data"
      )
    );
    grid.appendChild(
      metricCard(
        "Accuracy",
        fmtPct(metrics.accuracy, 1),
        metrics.expected_accuracy ? `expected ~${fmtPct(metrics.expected_accuracy, 0)}` : ""
      )
    );
    grid.appendChild(
      metricCard(
        "Top-move match",
        metrics.top_match === null || metrics.top_match === undefined ? "—" : fmtPct(metrics.top_match, 1),
        metrics.top_match === null || metrics.top_match === undefined
          ? "local engine only"
          : `expected ~${fmtPct(metrics.expected_top_match, 0)}`
      )
    );
    grid.appendChild(
      metricCard(
        "Fast-move accuracy",
        metrics.fast_accuracy === null || metrics.fast_accuracy === undefined ? "—" : fmtPct(metrics.fast_accuracy, 1),
        metrics.slow_accuracy !== null && metrics.slow_accuracy !== undefined
          ? `slower moves ${fmtPct(metrics.slow_accuracy, 1)}`
          : `${fmtInt(metrics.fast_moves)} fast moves`
      )
    );
    grid.appendChild(
      metricCard(
        "Performance",
        metrics.performance === null || metrics.performance === undefined ? "—" : fmtInt(metrics.performance),
        metrics.avg_rating ? `own rating ${fmtInt(metrics.avg_rating)}` : ""
      )
    );
    grid.appendChild(
      metricCard(
        "Games analysed",
        fmtInt(metrics.games_analyzed || metrics.games || 0),
        `${fmtInt(metrics.analyzed_moves || 0)} moves evaluated`
      )
    );
  }

  function renderMeta(meta, profile, metrics) {
    const list = $("#meta-list");
    clearNode(list);
    const rows = [
      ["Player", profile.username || meta.username || "—"],
      ["Source", meta.source === "pgn" ? "PGN import" : meta.source === "demo" ? "Demo report" : "Lichess"],
      ["Engine", engineLabel(meta.engine_mode, meta.engine_depth, meta.analysis_sources)],
      ["Games", `${fmtInt(meta.games_total)} total · ${fmtInt(meta.games_analyzed)} with engine data`],
      ["Moves", `${fmtInt(meta.moves_analyzed)} analysed · ${fmtInt(meta.timed_moves)} with clocks`],
      ["Avg. rating", fmtInt(meta.avg_rating)],
      ["Generated", (meta.generated_at || "").replace("T", " ").replace("+00:00", " UTC")],
    ];
    rows.forEach(([key, value]) => {
      list.appendChild(el("dt", null, key));
      const dd = el("dd", null, value);
      if (key === "Player" && profile.url) {
        clearNode(dd);
        const link = el("a", null, value);
        link.href = profile.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        dd.appendChild(link);
      }
      list.appendChild(dd);
    });

    const coverage = $("#coverage-bars");
    clearNode(coverage);
    const items = [
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

  function engineLabel(mode, depth, sources) {
    const counts = sources || {};
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

  function renderReasons(summary) {
    const container = $("#reasons");
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
        reason.severity === "high" ? "!" : reason.severity === "medium" ? "~" : reason.severity === "low" ? "↑" : "i"
      );
      const body = el("div");
      body.appendChild(el("div", "reason-title", reason.title || "Signal"));
      body.appendChild(el("div", "reason-detail", reason.detail || ""));
      node.appendChild(icon);
      node.appendChild(body);
      container.appendChild(node);
    });

    const components = summary.components || [];
    const strongest = components.slice(0, 3).map((c) => `${c.label} (z ${c.z > 0 ? "+" : ""}${c.z})`);
    setText(
      $("#reasons-sub"),
      strongest.length ? `Largest deviations: ${strongest.join(" · ")}` : "Not enough data for component scores"
    );

    const notes = $("#notes");
    clearNode(notes);
    (summary.notes || []).forEach((note) => notes.appendChild(el("div", "note", note)));
  }

  // ------------------------------------------------------------------ chart

  function drawGameChart(games) {
    const svg = $("#game-chart");
    clearNode(svg);
    const NS = "http://www.w3.org/2000/svg";
    const width = 900;
    const height = 240;
    const left = 42;
    const right = 14;
    const top = 16;
    const bottom = 34;
    const plotW = width - left - right;
    const plotH = height - top - bottom;

    const ordered = [...games].sort((a, b) => {
      const da = a.created_at || 0;
      const db = b.created_at || 0;
      return da - db;
    });
    if (!ordered.length) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", width / 2);
      text.setAttribute("y", height / 2);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "chart-axis-label");
      text.textContent = "No games";
      svg.appendChild(text);
      return;
    }

    [0, 25, 50, 75, 100].forEach((value) => {
      const y = top + plotH * (1 - value / 100);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", left);
      line.setAttribute("x2", width - right);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("class", "chart-grid-line");
      svg.appendChild(line);
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", left - 8);
      label.setAttribute("y", y + 3);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("class", "chart-axis-label");
      label.textContent = String(value);
      svg.appendChild(label);
    });

    const slot = plotW / ordered.length;
    const barW = Math.max(2, Math.min(22, slot * 0.66));
    ordered.forEach((game, index) => {
      const score = Number(game.suspicion) || 0;
      const x = left + slot * index + (slot - barW) / 2;
      const y = top + plotH * (1 - score / 100);
      const bar = document.createElementNS(NS, "rect");
      bar.setAttribute("x", x);
      bar.setAttribute("y", y);
      bar.setAttribute("width", barW);
      bar.setAttribute("height", Math.max(1, top + plotH - y));
      bar.setAttribute("rx", Math.min(3, barW / 2));
      bar.setAttribute("fill", scoreColor(score));
      bar.setAttribute("opacity", "0.9");
      bar.setAttribute("class", "chart-bar");
      const title = document.createElementNS(NS, "title");
      title.textContent = `${game.date || "unknown date"} · ${game.color === "white" ? "White" : "Black"} vs ${game.opponent}\nResult: ${game.result} · ACPL ${game.acpl ?? "—"} · Accuracy ${game.accuracy ?? "—"}%\nSignal ${score}/100`;
      bar.appendChild(title);
      svg.appendChild(bar);
    });

    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const labelLeft = document.createElementNS(NS, "text");
    labelLeft.setAttribute("x", left);
    labelLeft.setAttribute("y", height - 10);
    labelLeft.setAttribute("class", "chart-axis-label");
    labelLeft.textContent = first.date || "";
    svg.appendChild(labelLeft);
    const labelRight = document.createElementNS(NS, "text");
    labelRight.setAttribute("x", width - right);
    labelRight.setAttribute("y", height - 10);
    labelRight.setAttribute("text-anchor", "end");
    labelRight.setAttribute("class", "chart-axis-label");
    labelRight.textContent = last.date || "";
    svg.appendChild(labelRight);
  }

  // ------------------------------------------------------------------ table

  function populateSpeedFilter(games) {
    const select = $("#filter-speed");
    const current = select.value || "all";
    const speeds = Array.from(new Set(games.map((g) => g.speed).filter(Boolean))).sort();
    clearNode(select);
    const all = el("option", null, "All speeds");
    all.value = "all";
    select.appendChild(all);
    speeds.forEach((speed) => {
      const option = el("option", null, titleCase(speed));
      option.value = speed;
      select.appendChild(option);
    });
    select.value = speeds.includes(current) ? current : "all";
    state.filters.speed = select.value;
  }

  function filteredGames() {
    const games = (state.report && state.report.games) || [];
    return games.filter((game) => {
      if (state.filters.result !== "all" && game.result !== state.filters.result) return false;
      if (state.filters.color !== "all" && game.color !== state.filters.color) return false;
      if (state.filters.speed !== "all" && game.speed !== state.filters.speed) return false;
      return true;
    });
  }

  function sortedGames(games) {
    const key = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...games].sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (key === "date") {
        av = a.created_at || 0;
        bv = b.created_at || 0;
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (Number(av) - Number(bv)) * dir;
    });
  }

  function renderGames() {
    const tbody = $("#games-body");
    if (!tbody) return;
    clearNode(tbody);
    const all = filteredGames();
    const sorted = sortedGames(all);
    const limit = 300;
    const shown = sorted.slice(0, limit);

    shown.forEach((game) => {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.addEventListener("click", () => openGame(game));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openGame(game);
        }
      });

      const date = el("td", "game-date", game.date || "—");
      row.appendChild(date);

      const opponent = el("td", "game-opponent");
      opponent.appendChild(el("span", null, game.opponent || "—"));
      opponent.appendChild(el("small", null, `${titleCase(game.speed)} · ${game.opening || ""}`.replace(/ · $/, "")));
      row.appendChild(opponent);

      const color = el("td");
      color.appendChild(el("span", `chip ${game.color}`, game.color === "white" ? "W" : "B"));
      row.appendChild(color);

      const result = el("td");
      result.appendChild(el("span", `chip ${game.result}`, titleCase(game.result)));
      row.appendChild(result);

      row.appendChild(el("td", "num", game.player_rating ?? "—"));
      const acplCell = el("td", "num", game.acpl === null || game.acpl === undefined ? "—" : fmtNumber(game.acpl, 1));
      if (game.acpl !== null && game.acpl !== undefined) acplCell.classList.add(scoreClass(100 - game.acpl));
      row.appendChild(acplCell);
      row.appendChild(el("td", "num", fmtPct(game.accuracy, 1)));
      row.appendChild(el("td", "num", game.fast_accuracy === null || game.fast_accuracy === undefined ? "—" : fmtPct(game.fast_accuracy, 1)));

      const signal = el("td");
      const signalWrap = el("div", "signal-cell");
      const bar = el("div", "signal-bar");
      const fill = el("span");
      fill.style.width = `${Math.max(2, Math.min(100, Number(game.suspicion) || 0))}%`;
      fill.style.background = scoreColor(Number(game.suspicion) || 0);
      bar.appendChild(fill);
      signalWrap.appendChild(bar);
      signalWrap.appendChild(el("span", "signal-num", String(game.suspicion ?? "—")));
      signal.appendChild(signalWrap);
      row.appendChild(signal);

      tbody.appendChild(row);
    });

    const note = $("#table-note");
    if (!all.length) {
      note.textContent = "No games match these filters.";
    } else if (all.length > limit) {
      note.textContent = `Showing the top ${limit} of ${all.length} filtered games. Sort or filter to narrow the list. Click a row for the move-by-move review.`;
    } else {
      note.textContent = `${all.length} game${all.length === 1 ? "" : "s"} shown. Click a row for the move-by-move review.`;
    }
    setText($("#games-sub"), `${all.length} of ${(state.report.games || []).length} games`);
  }

  // ------------------------------------------------------------------ modal

  function openGame(game) {
    if (!game) return;
    setText($("#modal-kicker"), `Game review · signal ${game.suspicion ?? "—"}/100`);
    setText($("#modal-title"), `${game.white || "White"} vs ${game.black || "Black"}`);
    setText(
      $("#modal-subtitle"),
      `${game.date || "unknown date"} · ${titleCase(game.speed)} · ${game.time_control || ""} · ${game.opening || ""}`
    );
    const link = $("#modal-link");
    if (game.url) {
      link.href = game.url;
      link.classList.remove("hidden");
    } else {
      link.classList.add("hidden");
    }

    const metrics = $("#modal-metrics");
    clearNode(metrics);
    const items = [
      ["Signal", `${game.suspicion ?? "—"}/100`],
      ["ACPL", game.acpl === null || game.acpl === undefined ? "—" : fmtNumber(game.acpl, 1)],
      ["Accuracy", fmtPct(game.accuracy, 1)],
      ["Top match", game.top_match === null || game.top_match === undefined ? "—" : fmtPct(game.top_match * 100, 1)],
      ["Fast acc.", game.fast_accuracy === null || game.fast_accuracy === undefined ? "—" : fmtPct(game.fast_accuracy, 1)],
      ["Blunders", fmtInt(game.blunders)],
    ];
    items.forEach(([label, value]) => {
      const node = el("div", "modal-metric");
      node.appendChild(el("span", null, label));
      node.appendChild(el("strong", null, value));
      metrics.appendChild(node);
    });

    drawEvalChart(game);
    renderMoves(game);
    els.gameModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    setTimeout(() => $("#modal-close").focus(), 40);
  }

  function closeModal() {
    els.gameModal.classList.add("hidden");
    document.body.style.overflow = "";
  }

  function drawEvalChart(game) {
    const svg = $("#eval-chart");
    clearNode(svg);
    const NS = "http://www.w3.org/2000/svg";
    const width = 900;
    const height = 220;
    const left = 34;
    const right = 12;
    const top = 14;
    const bottom = 22;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const center = top + plotH / 2;
    const scale = plotH / 2 / 6;

    const defs = document.createElementNS(NS, "defs");
    const gradient = document.createElementNS(NS, "linearGradient");
    gradient.setAttribute("id", "eval-gradient");
    gradient.setAttribute("x1", "0");
    gradient.setAttribute("y1", "0");
    gradient.setAttribute("x2", "0");
    gradient.setAttribute("y2", "1");
    const stopTop = document.createElementNS(NS, "stop");
    stopTop.setAttribute("offset", "0%");
    stopTop.setAttribute("stop-color", "#4fd1c5");
    stopTop.setAttribute("stop-opacity", "0.35");
    const stopMid = document.createElementNS(NS, "stop");
    stopMid.setAttribute("offset", "50%");
    stopMid.setAttribute("stop-color", "#4fd1c5");
    stopMid.setAttribute("stop-opacity", "0.04");
    const stopBottom = document.createElementNS(NS, "stop");
    stopBottom.setAttribute("offset", "100%");
    stopBottom.setAttribute("stop-color", "#ff6b6b");
    stopBottom.setAttribute("stop-opacity", "0.35");
    gradient.appendChild(stopTop);
    gradient.appendChild(stopMid);
    gradient.appendChild(stopBottom);
    defs.appendChild(gradient);
    svg.appendChild(defs);

    const centerLine = document.createElementNS(NS, "line");
    centerLine.setAttribute("x1", left);
    centerLine.setAttribute("x2", width - right);
    centerLine.setAttribute("y1", center);
    centerLine.setAttribute("y2", center);
    centerLine.setAttribute("stroke", "#2a3a4c");
    centerLine.setAttribute("stroke-width", "1");
    centerLine.setAttribute("stroke-dasharray", "4 4");
    svg.appendChild(centerLine);

    const moves = (game.moves || []).filter((move) => move.eval_cp !== null && move.eval_cp !== undefined);
    if (!moves.length) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", width / 2);
      text.setAttribute("y", height / 2);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "chart-axis-label");
      text.textContent = "No engine evaluations for this game";
      svg.appendChild(text);
      return;
    }

    const points = moves.map((move, index) => {
      const x = left + (moves.length === 1 ? plotW / 2 : (index / (moves.length - 1)) * plotW);
      const pawns = Math.max(-6, Math.min(6, (Number(move.eval_cp) || 0) / 100));
      const y = center - pawns * scale;
      return { x, y, move };
    });

    const area = document.createElementNS(NS, "path");
    let d = `M ${points[0].x} ${center} L ${points[0].x} ${points[0].y}`;
    points.forEach((point) => {
      d += ` L ${point.x} ${point.y}`;
    });
    d += ` L ${points[points.length - 1].x} ${center} Z`;
    area.setAttribute("d", d);
    area.setAttribute("fill", "url(#eval-gradient)");
    svg.appendChild(area);

    const line = document.createElementNS(NS, "path");
    line.setAttribute("d", points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#b8c6d6");
    line.setAttribute("stroke-width", "1.6");
    line.setAttribute("stroke-linejoin", "round");
    svg.appendChild(line);

    points.forEach(({ x, y, move }) => {
      const judgment = move.judgment;
      if (!judgment) return;
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", y);
      dot.setAttribute("r", judgment === "blunder" ? "3.4" : "2.6");
      dot.setAttribute("fill", judgment === "blunder" ? "#ff6b6b" : judgment === "mistake" ? "#f08c4c" : "#f5b84c");
      const title = document.createElementNS(NS, "title");
      title.textContent = `${move.move_no}${move.color === "white" ? "." : "..."} ${move.san} · eval ${fmtPawns(move.eval_cp)} · ${judgment}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    ["+6", "0", "−6"].forEach((label, index) => {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", left - 8);
      text.setAttribute("y", index === 0 ? top + 4 : index === 1 ? center + 3 : height - bottom + 4);
      text.setAttribute("text-anchor", "end");
      text.setAttribute("class", "chart-axis-label");
      text.textContent = label;
      svg.appendChild(text);
    });
  }

  function renderMoves(game) {
    const wrap = $("#moves-wrap");
    clearNode(wrap);
    const moves = game.moves || [];
    if (!moves.length) {
      const message = game.detail_available === false
        ? "Move detail is only kept for the top games in very large scans."
        : "No move data available for this game.";
      wrap.appendChild(el("div", "moves-empty", message));
      return;
    }

    const header = el("div", "moves-header");
    header.appendChild(el("span", null, "#"));
    header.appendChild(el("span", null, "White"));
    header.appendChild(el("span", null, "Black"));
    wrap.appendChild(header);

    const byNumber = new Map();
    moves.forEach((move) => {
      const number = move.move_no || Math.ceil(move.ply / 2);
      if (!byNumber.has(number)) byNumber.set(number, {});
      byNumber.get(number)[move.color] = move;
    });

    Array.from(byNumber.keys())
      .sort((a, b) => a - b)
      .forEach((number) => {
        const pair = byNumber.get(number);
        const row = el("div", "move-row");
        row.appendChild(el("div", "move-no", `${number}.`));
        row.appendChild(buildMoveCell(pair.white, game));
        row.appendChild(buildMoveCell(pair.black, game));
        wrap.appendChild(row);
      });
  }

  function buildMoveCell(move, game) {
    const cell = el("div", "move");
    if (!move) return cell;
    const fastThreshold = game.fast_threshold || 3;
    const fastAccurate =
      move.think_time !== null &&
      move.think_time !== undefined &&
      move.think_time <= fastThreshold &&
      move.accuracy !== null &&
      move.accuracy !== undefined &&
      move.accuracy >= 90;
    if (fastAccurate) cell.classList.add("fast-accurate");

    cell.appendChild(el("span", "san", move.san));
    const metaBits = [];
    if (move.eval_cp !== null && move.eval_cp !== undefined) metaBits.push(fmtPawns(move.eval_cp));
    if (move.think_time !== null && move.think_time !== undefined) metaBits.push(fmtTime(move.think_time));
    if (metaBits.length) cell.appendChild(el("span", "meta", metaBits.join(" · ")));

    if (move.judgment) {
      cell.appendChild(el("span", `badge ${move.judgment}`, move.judgment));
    }
    if (move.best_san && move.best_san !== move.san && move.judgment) {
      cell.appendChild(el("span", "best", `best ${move.best_san}`));
    }
    return cell;
  }

  // -------------------------------------------------------------------- AI

  async function runAiSummary() {
    if (!state.jobId) {
      toast("AI summaries are available for live scans only", true);
      return;
    }
    const model = els.aiModel.value;
    if (!model) {
      toast("Choose a local model first", true);
      return;
    }
    els.aiRun.disabled = true;
    els.aiOutput.textContent = "Thinking locally…";
    els.aiOutput.classList.add("loading");
    try {
      const data = await api(`/api/jobs/${state.jobId}/ai-summary`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      els.aiOutput.textContent = data.summary || "The model returned an empty response.";
      els.aiOutput.classList.remove("loading");
    } catch (error) {
      els.aiOutput.textContent = error.message;
      els.aiOutput.classList.remove("loading");
      toast(error.message, true);
    } finally {
      els.aiRun.disabled = false;
    }
  }

  // ---------------------------------------------------------------- exports

  function exportJson() {
    if (!state.report) return;
    if (state.jobId && !state.demo) {
      window.location.href = `/api/jobs/${state.jobId}/export.json`;
      return;
    }
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
    downloadBlob(blob, `knightwatch-${safeName(state.report.meta.username)}-demo.json`);
  }

  function exportCsv() {
    if (!state.report) return;
    if (state.jobId && !state.demo) {
      window.location.href = `/api/jobs/${state.jobId}/export.csv`;
      return;
    }
    const headers = [
      "date", "game_id", "url", "color", "opponent", "opponent_rating", "result",
      "speed", "time_control", "opening", "moves", "analyzed_moves", "acpl",
      "accuracy", "top_match", "blunders", "fast_accuracy", "suspicion", "flags",
    ];
    const rows = (state.report.games || []).map((game) =>
      [
        game.date, game.game_id, game.url, game.color, game.opponent, game.opponent_rating,
        game.result, game.speed, game.time_control, game.opening, game.moves_count,
        game.analyzed_moves, game.acpl, game.accuracy, game.top_match, game.blunders,
        game.fast_accuracy, game.suspicion, (game.flags || []).join("|"),
      ]
        .map((value) => {
          const text = value === null || value === undefined ? "" : String(value);
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `knightwatch-${safeName(state.report.meta.username)}-demo.csv`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeName(name) {
    return String(name || "player").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
  }

  init();
})();
