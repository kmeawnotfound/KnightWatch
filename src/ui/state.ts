import { ClientJobManager } from "../lib/jobs.js";
import type { GameMetrics, Report } from "../lib/types";
import type { Filters, SortDir } from "./view-types";

export interface UiState {
  jobId: string | null;
  pollTimer: number | null;
  pollErrors: number;
  report: Report | null;
  demo: boolean;
  sortKey: string;
  sortDir: SortDir;
  filters: Filters;
  lastLogCount: number;
  finished: boolean;
  engineWorkers: number;
  warmStarted: boolean;
  engineReady: boolean;
  selectedGame: GameMetrics | null;
  boardIndex: number;
  boardFlipped: boolean;
  librarySelection: string[];
}

export const jobs = new ClientJobManager();

export const state: UiState = {
  jobId: null,
  pollTimer: null,
  pollErrors: 0,
  report: null,
  demo: false,
  sortKey: "suspicion",
  sortDir: "desc",
  filters: { result: "all", color: "all", speed: "all" },
  lastLogCount: -1,
  finished: false,
  engineWorkers: 4,
  warmStarted: false,
  engineReady: false,
  selectedGame: null,
  boardIndex: 0,
  boardFlipped: false,
  librarySelection: [],
};
