import {
  aggregateReport,
  attachCloudAnalysis,
  attachEngineAnalysis,
  attachEngineTopMatch,
  computeGameMetrics,
  finalizeGames,
  parseNdjsonGame,
  parsePgnGames,
  trimReportDetails,
} from "./analysis";
import { moveAsDict, normalizeName } from "./chess-utils";
import {
  ChessComError,
  chessComSpeed,
  fetchChessComGames,
  getChessComProfile,
} from "./chesscom";
import {
  StockfishPool,
  getEnginePool,
  isEnginePoolReady,
  onEnginePoolProgress,
  releaseEnginePool,
} from "./engine";
import { CloudEvaluator, JobCancelled, LichessError, getProfile, iterGames } from "./lichess";
import { deleteReport, loadReport, saveReport } from "./storage";
import type {
  Color,
  GameMetrics,
  GameRecord,
  JobSnapshot,
  JobStatus,
  Profile,
  Report,
} from "./types";

const MAX_DETAIL_GAMES = 250;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  } catch {
    return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
  }
}

function intOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function colorOf(game: GameRecord, name: string | null | undefined): Color | null {
  const needle = normalizeName(name);
  if (!needle) return null;
  if (normalizeName(game.white) === needle) return "white";
  if (normalizeName(game.black) === needle) return "black";
  return null;
}

interface InternalJob extends JobSnapshot {
  report: Report | null;
  token: string | null;
  pgn: string | null;
  cancel: boolean;
  controller: AbortController | null;
}

export class ClientJobManager {
  private jobs = new Map<string, InternalJob>();

  createLichessJob(params: Record<string, any>, token: string | null): string {
    const id = randomId();
    const publicParams: Record<string, any> = { ...params };
    delete publicParams.token;
    const job = this.newJob(id, "lichess", publicParams);
    job.token = (token || "").trim() || null;
    void this.run(job);
    return id;
  }

  createPgnJob(params: Record<string, any>): string {
    const id = randomId();
    const publicParams: Record<string, any> = { ...params };
    const pgn = String(publicParams.pgn || "");
    delete publicParams.pgn;
    const job = this.newJob(id, "pgn", publicParams);
    job.pgn = pgn;
    void this.run(job);
    return id;
  }

  createChessComJob(params: Record<string, any>): string {
    const id = randomId();
    const publicParams: Record<string, any> = { ...params };
    const job = this.newJob(id, "chesscom", publicParams);
    void this.run(job);
    return id;
  }

  get(jobId: string): JobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  async getReport(jobId: string): Promise<Report | null> {
    const job = this.jobs.get(jobId);
    if (job?.report) return job.report;
    return loadReport(jobId);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.cancel = true;
    try {
      job.controller?.abort();
    } catch {
      /* ignore */
    }
    if (job.status === "queued") {
      job.status = "cancelled";
      job.phase = "cancelled";
      job.finished_at = nowIso();
    }
    this.log(job, "Cancellation requested.");
    return true;
  }

  async delete(jobId: string): Promise<boolean> {
    const existed = this.jobs.delete(jobId);
    await deleteReport(jobId);
    return existed;
  }

  // ------------------------------------------------------------- internals

  private newJob(id: string, kind: "lichess" | "chesscom" | "pgn", params: Record<string, any>): InternalJob {
    const job: InternalJob = {
      id,
      kind,
      status: "queued",
      phase: "queued",
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      params,
      progress: {
        percent: 0,
        fetched: 0,
        total_hint: null,
        analyzed: 0,
        total_games: 0,
        current_game: null,
        eta_seconds: null,
      },
      logs: [],
      error: null,
      error_hint: null,
      profile: null,
      report_ready: false,
      summary: null,
      report: null,
      token: null,
      pgn: null,
      cancel: false,
      controller: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  private async run(job: InternalJob): Promise<void> {
    if (job.cancel) {
      this.setStatus(job, "cancelled");
      return;
    }
    this.setStatus(job, "running");
    job.started_at = nowIso();
    try {
      if (job.kind === "pgn") await this.runPgn(job);
      else if (job.kind === "chesscom") await this.runChessCom(job);
      else await this.runLichess(job);
    } catch (error) {
      if (error instanceof JobCancelled) {
        this.setStatus(job, "cancelled");
        this.log(job, "Scan cancelled.");
      } else if (error instanceof LichessError || error instanceof ChessComError) {
        this.fail(job, error.message, error.hint);
      } else if (job.cancel) {
        this.setStatus(job, "cancelled");
        this.log(job, "Scan cancelled.");
      } else {
        this.fail(
          job,
          `Unexpected error: ${(error as Error).message || String(error)}`,
          "Open the browser console for details.",
        );
      }
    } finally {
      job.token = null;
      job.pgn = null;
      job.controller = null;
      releaseEnginePool();
    }
  }

  private async runLichess(job: InternalJob): Promise<void> {
    const params = job.params;
    const username = String(params.username || "").trim();
    const token = job.token;
    const maxGames =
      params.max_games === 0 ? 0 : intOrZero(params.max_games) || 50;
    const perf = String(params.perf || "all");
    const includeUnrated = Boolean(params.include_unrated);

    this.phase(job, "profile", 2, "Loading Lichess profile…");
    const profile = await getProfile(username, token);
    job.profile = profile;
    this.log(job, `Loaded ${profile.username} (${profile.title || "player"}).`);

    let totalHint: number | null = null;
    if (maxGames > 0) {
      if (perf !== "all") {
        totalHint = Math.min(maxGames, intOrZero((profile.perfs || {})[perf]?.games) || maxGames);
      } else {
        totalHint = Math.min(maxGames, intOrZero((profile.counts || {}).all) || maxGames);
      }
    } else if (perf !== "all") {
      totalHint = intOrZero((profile.perfs || {})[perf]?.games) || null;
    } else {
      totalHint = intOrZero((profile.counts || {}).all) || null;
    }
    job.progress.total_hint = totalHint;

    // Warm the engine while the games download so the first scan does not
    // stall at "Preparing analysis…".
    const requestedEngine = String(params.engine || "auto").toLowerCase();
    if (requestedEngine === "auto" || requestedEngine === "stockfish") {
      void getEnginePool().catch(() => undefined);
    }

    this.phase(job, "fetching", 5, "Downloading games from Lichess…");
    const rawGames: Record<string, any>[] = [];
    const controller = new AbortController();
    job.controller = controller;

    const result = await iterGames(username, {
      maxGames,
      perf,
      includeUnrated,
      token,
      totalHint,
      signal: controller.signal,
      cancelCheck: () => job.cancel,
      onGame: (raw, index) => {
        if (job.cancel) throw new JobCancelled();
        rawGames.push(raw);
        if (index % 5 === 0) {
          this.progressFetch(job, rawGames.length, totalHint);
          this.log(job, `Downloaded ${rawGames.length} games…`);
        }
      },
      onProgress: (count, hint) => this.progressFetch(job, count, hint),
    });
    if (result.warning) {
      this.log(job, result.warning);
      if (!Array.isArray(job.params.warnings)) job.params.warnings = [];
      job.params.warnings.push(result.warning);
    }
    if (!rawGames.length) {
      throw new LichessError("No games were returned.", {
        hint: "Try a different time control or include unrated games. If the account has games, make sure the token is valid.",
      });
    }
    this.log(job, `Downloaded ${rawGames.length} games.`);
    await this.analyzeGames(job, rawGames, profile, false, profile.username || username);
  }

  private async runChessCom(job: InternalJob): Promise<void> {
    const params = job.params;
    const username = String(params.username || "").trim();
    const maxGames = intOrZero(params.max_games) || 50;
    const timeClass = String(params.time_class || "all").toLowerCase();
    const includeUnrated = Boolean(params.include_unrated);

    this.phase(job, "profile", 2, "Loading Chess.com profile…");
    const controller = new AbortController();
    job.controller = controller;
    const ccProfile = await getChessComProfile(username, controller.signal);
    if (job.cancel) throw new JobCancelled();

    const profile: Profile = {
      username: ccProfile.username || username,
      id: String(ccProfile.player_id ?? "chesscom"),
      title: ccProfile.title || null,
      url: ccProfile.url || `https://www.chess.com/member/${encodeURIComponent(username)}`,
      perfs: {},
      counts: { all: 0 },
    };
    job.profile = profile;
    job.progress.total_hint = maxGames;
    this.log(job, `Loaded ${profile.username}${ccProfile.title ? ` (${ccProfile.title})` : ""}.`);

    // Warm the engine while the archives download so the first scan does not
    // stall at "Preparing analysis…".
    const requestedEngine = String(params.engine || "auto").toLowerCase();
    if (requestedEngine === "auto" || requestedEngine === "stockfish") {
      void getEnginePool().catch(() => undefined);
    }

    this.phase(job, "fetching", 5, "Downloading games from Chess.com…");
    const result = await fetchChessComGames({
      username,
      maxGames,
      timeClass,
      includeUnrated,
      signal: controller.signal,
      onProgress: (found, months) => {
        this.progressFetch(job, found, maxGames);
        this.log(
          job,
          `Found ${found} matching game${found === 1 ? "" : "s"} across ${months} month${months === 1 ? "" : "s"}…`,
        );
      },
    });
    if (job.cancel) throw new JobCancelled();

    if (result.warning) {
      this.log(job, result.warning);
      if (!Array.isArray(job.params.warnings)) job.params.warnings = [];
      job.params.warnings.push(result.warning);
    }

    // Chess.com returns JSON games with an embedded PGN. Parse each one and
    // let its time_class override the PGN-derived speed (notably daily games).
    const games: GameRecord[] = [];
    const seen = new Set<string>();
    for (const raw of result.games) {
      if (job.cancel) throw new JobCancelled();
      const parsed = parsePgnGames(String(raw.pgn || ""), 1);
      if (!parsed.length) continue;
      const game = parsed[0];
      const speed = chessComSpeed(String(raw.time_class || "")) || game.speed;
      game.speed = speed;
      game.perf = speed;
      if (raw.url) {
        game.url = String(raw.url);
        const tail = game.url.replace(/\/+$/, "").split("/").filter(Boolean);
        if (tail.length) game.id = tail[tail.length - 1];
      }
      if (seen.has(game.id)) continue;
      seen.add(game.id);
      games.push(game);
    }

    if (!games.length) {
      throw new ChessComError("No matching Chess.com games were found.", {
        hint: "Try another time control, include unrated games, or scan an account with recent public games.",
      });
    }
    profile.counts = { all: games.length };
    job.progress.total_hint = games.length;
    this.log(job, `Downloaded ${games.length} games from Chess.com.`);
    await this.analyzeGames(job, games, profile, true, profile.username || username);
  }

  private async runPgn(job: InternalJob): Promise<void> {
    const params = job.params;
    const pgnText = job.pgn || "";
    const player = String(params.player || "").trim();
    if (!pgnText.trim()) throw new LichessError("No PGN supplied.");
    if (pgnText.length > 8_000_000) {
      throw new LichessError("That PGN is too large. Limit the import to a few thousand games.");
    }

    this.phase(job, "parsing", 4, "Parsing PGN…");
    const games = parsePgnGames(pgnText, intOrZero(params.max_games) || 100);
    if (!games.length) {
      throw new LichessError("No standard-chess games with moves were found in the PGN.", {
        hint: "Make sure the PGN contains at least one completed game.",
      });
    }
    this.log(job, `Parsed ${games.length} PGN games.`);
    const profile: Profile = {
      username: player || "Imported PGN",
      id: "pgn",
      url: "",
      title: null,
      perfs: {},
      counts: { all: games.length },
    };
    job.profile = profile;
    job.progress.total_hint = games.length;
    await this.analyzeGames(job, games, profile, true, player || null);
  }

  private async analyzeGames(
    job: InternalJob,
    items: any[],
    profile: Profile,
    alreadyParsed: boolean,
    username: string | null,
  ): Promise<void> {
    const params = job.params;
    const engineMode = String(params.engine || "auto").toLowerCase();
    const depth = intOrZero(params.depth) || 14;
    const samplesRaw = Number(params.samples);
    const samples = samplesRaw === 0 ? 0 : intOrZero(params.samples) || 24;
    const reanalyze = Boolean(params.reanalyze);
    const warnings: string[] = Array.isArray(params.warnings) ? [...params.warnings] : [];

    this.phase(job, "analyzing", 35, "Preparing analysis…");
    let pool: StockfishPool | null = null;
    let cloud: CloudEvaluator | null = null;
    let activeMode = engineMode;

    if (engineMode === "auto" || engineMode === "stockfish") {
      if (!isEnginePoolReady()) {
        this.phase(job, "engine", 35, "Loading Stockfish WASM…");
      }
      const stopListening = onEnginePoolProgress((done, total) => {
        if (done >= total) return;
        job.progress.percent = 35 + Math.round((done / total) * 4);
        this.log(job, `Loading Stockfish WASM… ${done}/${total} workers ready.`);
      });
      try {
        pool = await getEnginePool();
        activeMode = "stockfish";
        this.log(
          job,
          `Local engine pool ready: ${pool.engineName}, ${pool.workers} worker(s), depth ${depth}, ${pool.hashMb} MB hash each.`,
        );
      } catch (error) {
        const message = (error as Error).message || String(error);
        warnings.push(`Stockfish unavailable: ${message}`);
        this.log(job, `Stockfish unavailable: ${message}`);
        pool = null;
        activeMode = engineMode === "stockfish" ? "cloud" : "auto";
      } finally {
        stopListening();
      }
    }

    if (engineMode === "cloud" || activeMode === "cloud" || (engineMode === "auto" && !pool)) {
      cloud = new CloudEvaluator();
      activeMode = "cloud";
      this.log(job, "Cloud evaluation enabled (throttled and cached).");
    }

    if (engineMode === "lichess") {
      activeMode = "lichess";
      this.log(job, "Using existing Lichess analysis only.");
    }

    const total = items.length;
    const gameMetrics: GameMetrics[] = [];
    const started = performance.now();
    let skipped = 0;
    let completed = 0;

    const processGame = async (
      item: any,
      analyzer: import("./engine").UciEngine | null,
    ): Promise<[GameRecord | null, GameMetrics | null]> => {
      if (job.cancel) throw new JobCancelled();
      const game: GameRecord | null = alreadyParsed ? item : parseNdjsonGame(item);
      if (!game) return [null, null];

      let color = colorOf(game, username);
      if (!color) color = colorOf(game, String(profile.username || ""));
      if (!color && alreadyParsed && !username) color = "white";
      if (!color) return [game, null];

      const force = reanalyze && (activeMode === "stockfish" || activeMode === "cloud");
      const hasEval = game.raw_has_analysis;
      // The analyser interface takes only a FEN; bind the configured depth here.
      const boundAnalyzer = analyzer
        ? { evaluate: (fen: string) => analyzer.evaluate(fen, depth) }
        : null;
      try {
        if (activeMode === "stockfish" && boundAnalyzer && (!hasEval || force)) {
          const attached = await attachEngineAnalysis(
            game,
            color,
            boundAnalyzer,
            samples,
            depth,
            force,
            () => job.cancel,
          );
          if (attached === 0 && !hasEval) warnings.push(`Engine could not evaluate ${game.id}.`);
        } else if (activeMode === "stockfish" && boundAnalyzer && hasEval && !force) {
          await attachEngineTopMatch(game, color, boundAnalyzer, samples, depth, () => job.cancel);
        } else if (activeMode === "cloud" && cloud && (!hasEval || force)) {
          await attachCloudAnalysis(game, color, cloud, samples, force);
        } else if (activeMode === "auto" && !hasEval && !analyzer && cloud) {
          await attachCloudAnalysis(game, color, cloud, samples);
        }
      } catch (error) {
        if (error instanceof JobCancelled) throw error;
        warnings.push(`Stockfish stopped: ${(error as Error).message}`);
        this.log(job, `Stockfish stopped on ${game.id}: ${(error as Error).message}`);
      }

      const metrics = computeGameMetrics(game, color);
      metrics.moves = game.moves.map(moveAsDict);
      metrics.detail_available = true;
      return [game, metrics];
    };

    if (pool && activeMode === "stockfish") {
      this.phase(job, "analyzing", 40, `Analysing ${total} game${total === 1 ? "" : "s"}…`);
    }

    try {
      if (pool && activeMode === "stockfish") {
        const enginePool = pool;
        let nextIndex = 0;
        const runWorker = async () => {
          while (true) {
            if (job.cancel) throw new JobCancelled();
            const index = nextIndex;
            nextIndex += 1;
            if (index >= total) return;
            const [game, metrics] = await enginePool.withEngine((engine) =>
              processGame(items[index], engine),
            );
            if (job.cancel) throw new JobCancelled();
            if (!metrics || !game) {
              skipped += 1;
              continue;
            }
            gameMetrics.push(metrics);
            completed += 1;
            this.progressAnalysis(job, completed, total, started, game);
          }
        };
        await Promise.all(Array.from({ length: enginePool.workers }, () => runWorker()));
      } else {
        for (let index = 0; index < total; index += 1) {
          if (job.cancel) throw new JobCancelled();
          const [game, metrics] = await processGame(items[index], null);
          if (!metrics || !game) {
            skipped += 1;
            continue;
          }
          gameMetrics.push(metrics);
          completed += 1;
          this.progressAnalysis(job, completed, total, started, game);
        }
      }
    } finally {
      if (pool) {
        // Interrupted searches should not keep burning CPU; otherwise keep the
        // pool warm so the next scan starts instantly.
        if (job.cancel) pool.stopAll();
        releaseEnginePool();
      }
    }

    if (!gameMetrics.length) {
      throw new LichessError("No usable games were found for this player.", {
        hint: "The player may not appear in the downloaded games, or all games were variants.",
      });
    }
    if (skipped) this.log(job, `Skipped ${skipped} games (variant, missing player, or invalid moves).`);

    this.phase(job, "scoring", 96, "Scoring and building report…");
    finalizeGames(gameMetrics);
    const report = aggregateReport(gameMetrics, {
      username: String(profile.username || username || "Unknown"),
      profile,
      engineMode: activeMode,
      depth,
      samples,
      source: job.kind,
      warnings,
    });
    trimReportDetails(report, MAX_DETAIL_GAMES);
    job.report = report;
    job.report_ready = true;
    job.profile = profile;
    job.summary = {
      score: report.summary.score,
      verdict: report.summary.verdict,
      confidence_label: report.summary.confidence_label,
      games: Number(report.summary.metrics.games || 0),
    };
    await saveReport(job.id, report);
    this.phase(job, "done", 100, "Done");
    job.status = "done";
    job.finished_at = nowIso();
    this.log(job, `Report ready: ${report.summary.score}/100 (${report.summary.verdict}).`);
  }

  // ------------------------------------------------------------- reporting

  private snapshot(job: InternalJob): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      params: job.params,
      progress: job.progress,
      logs: (job.logs || []).slice(-60),
      error: job.error,
      error_hint: job.error_hint,
      profile: job.profile,
      report_ready: Boolean(job.report),
      summary: job.summary,
    };
  }

  private setStatus(job: InternalJob, status: JobStatus): void {
    job.status = status;
    if (status === "cancelled" || status === "error") {
      job.phase = status;
      job.finished_at = nowIso();
    }
  }

  private fail(job: InternalJob, message: string, hint: string | null = null): void {
    job.status = "error";
    job.phase = "error";
    job.error = message;
    job.error_hint = hint;
    job.finished_at = nowIso();
    this.log(job, `Error: ${message}`);
  }

  private phase(job: InternalJob, phase: string, percent: number, message: string): void {
    job.phase = phase;
    job.progress.percent = percent;
    this.log(job, message);
  }

  private progressFetch(job: InternalJob, count: number, hint: number | null): void {
    job.progress.fetched = count;
    job.progress.total_hint = hint;
    if (hint) {
      job.progress.percent = Math.min(35, 5 + Math.trunc((30 * count) / Math.max(hint, 1)));
    } else {
      job.progress.percent = Math.min(35, 5 + Math.trunc(30 * (1 - Math.exp(-count / 40))));
    }
  }

  private progressAnalysis(
    job: InternalJob,
    done: number,
    total: number,
    startedMs: number,
    game: GameRecord,
  ): void {
    const elapsed = (performance.now() - startedMs) / 1000;
    const eta = done > 0 ? Math.trunc((elapsed / done) * Math.max(0, total - done)) : null;
    job.progress.analyzed = done;
    job.progress.total_games = total;
    job.progress.percent = Math.min(95, 40 + Math.trunc((55 * done) / Math.max(total, 1)));
    job.progress.current_game = game.id;
    job.progress.eta_seconds = eta;
    if (done && done % 10 === 0) this.log(job, `Analysed ${done}/${total} games…`);
  }

  private log(job: InternalJob, message: string): void {
    job.logs.push({ ts: nowIso(), message });
    if (job.logs.length > 60) job.logs = job.logs.slice(-60);
  }
}
