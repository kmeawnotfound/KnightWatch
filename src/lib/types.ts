export type Color = "white" | "black";

export interface MoveRecord {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  legal_count: number | null;
  clock: number | null;
  think_time: number | null;
  eval_cp: number | null;
  eval_before_cp: number | null;
  mate: number | null;
  loss_cp: number | null;
  accuracy: number | null;
  win_drop: number | null;
  judgment: string | null;
  best_uci: string | null;
  best_san: string | null;
  is_best: boolean | null;
  source: string | null;
}

export interface GameRecord {
  id: string;
  url: string;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  result: string;
  winner: string | null;
  status: string;
  speed: string;
  perf: string;
  created_at: number | null;
  opening: string;
  eco: string;
  time_control: string;
  clock_initial: number | null;
  clock_increment: number | null;
  book_ply: number;
  variant: string;
  moves: MoveRecord[];
  analysis_source: string | null;
  engine_depth: number | null;
  player_analysis: Record<string, Record<string, unknown>>;
  raw_has_analysis: boolean;
  warnings: string[];
}

export interface EngineEval {
  cp: number;
  mate: number | null;
  best_uci: string | null;
  depth: number;
}

export interface ProfilePerf {
  rating?: number | null;
  games?: number | null;
  prog?: number | null;
  prov?: boolean;
}

export interface Profile {
  username: string;
  id: string;
  title?: string | null;
  patron?: boolean;
  created_at?: number | null;
  seen_at?: number | null;
  url?: string;
  perfs: Record<string, ProfilePerf>;
  counts: Record<string, number>;
  play_time_hours?: number;
  profile?: Record<string, unknown>;
}

export interface ReportComponent {
  key: string;
  label: string;
  value: number | null;
  expected: number | null;
  z: number;
  weight: number;
  unit: string;
  detail: string;
}

export interface ReportReason {
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
}

export interface GameMetrics {
  game_id: string;
  url: string;
  date: string | null;
  created_at: number | null;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  color: Color;
  opponent: string;
  opponent_rating: number | null;
  player_rating: number | null;
  rating_diff: number | null;
  result: "win" | "loss" | "draw";
  score: number;
  speed: string;
  perf: string;
  time_control: string;
  opening: string;
  eco: string;
  status: string;
  moves_count: number;
  analyzed_moves: number;
  acpl: number | null;
  accuracy: number | null;
  top_match: number | null;
  top_moves: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  blunder_rate: number | null;
  fast_threshold: number;
  fast_moves: number;
  slow_moves: number;
  fast_accuracy: number | null;
  slow_accuracy: number | null;
  fast_share: number | null;
  median_time: number | null;
  mean_time: number | null;
  time_cv: number | null;
  timed_moves: number;
  performance: number | null;
  engine_source: string | null;
  engine_depth: number | null;
  flags: string[];
  suspicion?: number;
  moves?: Record<string, unknown>[];
  detail_available?: boolean;
  _fast_acc_sum?: number;
  _fast_acc_n?: number;
  _slow_acc_sum?: number;
  _slow_acc_n?: number;
}

export interface Report {
  meta: Record<string, any>;
  profile: Profile | Record<string, any>;
  summary: {
    score: number;
    verdict: string;
    confidence: number;
    confidence_label: string;
    raw_z: number;
    metrics: Record<string, any>;
    components: ReportComponent[];
    reasons: ReportReason[];
    notes: string[];
  };
  games: GameMetrics[];
}

export type EngineMode = "auto" | "stockfish" | "cloud" | "lichess";

export interface ScanParams {
  username?: string;
  perf?: string;
  max_games?: number;
  include_unrated?: boolean;
  engine?: EngineMode;
  depth?: number;
  samples?: number;
  reanalyze?: boolean;
  player?: string | null;
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobProgress {
  percent: number;
  fetched: number;
  total_hint: number | null;
  analyzed: number;
  total_games: number;
  current_game: string | null;
  eta_seconds: number | null;
}

export interface JobSnapshot {
  id: string;
  kind: "lichess" | "pgn";
  status: JobStatus;
  phase: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  params: Record<string, any>;
  progress: JobProgress;
  logs: { ts: string; message: string }[];
  error: string | null;
  error_hint: string | null;
  profile: Profile | Record<string, any> | null;
  report_ready: boolean;
  summary: {
    score: number;
    verdict: string;
    confidence_label: string;
    games: number;
  } | null;
}
