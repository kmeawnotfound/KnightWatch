import type { EngineEval } from "./types";
import { sideToMove } from "./chess-utils";

/**
 * Minimal UCI wrapper around the bundled Stockfish WASM worker.
 *
 * The worker script is an Emscripten build that uses the global
 * `onmessage`/`postMessage` pair and prints every UCI line as its own message.
 * One engine instance is single-threaded, which is the fastest configuration
 * for many independent positions; parallelism comes from running several
 * workers at once.
 */

export const ENGINE_SCRIPT = "engine/stockfish-19-lite-single.js";

export function engineScriptUrl(): string {
  return new URL(ENGINE_SCRIPT, document.baseURI).href;
}

export function defaultWorkerCount(): number {
  const cores =
    typeof navigator !== "undefined" && Number(navigator.hardwareConcurrency)
      ? Number(navigator.hardwareConcurrency)
      : 4;
  return Math.max(1, Math.min(8, cores - 1));
}

export function defaultHashMb(workers: number): number {
  const memoryGb =
    typeof navigator !== "undefined" && Number((navigator as any).deviceMemory)
      ? Number((navigator as any).deviceMemory)
      : 4;
  const totalMb = memoryGb * 1024;
  // Keep the pool's total transposition table around 1 GB or less; depth 12
  // searches gain little from more, and each worker also needs its own WASM
  // heap. More RAM still helps when the browser reports it.
  const budget = Math.min(1024, Math.floor(totalMb / 8));
  const perWorker = Math.floor(budget / Math.max(1, workers));
  return Math.max(16, Math.min(256, perWorker));
}

type LineListener = (line: string) => void;

function parseScore(line: string): { cp: number | null; mate: number | null } | null {
  const mate = /\bscore mate (-?\d+)/.exec(line);
  if (mate) return { cp: null, mate: Number(mate[1]) };
  const cp = /\bscore cp (-?\d+)/.exec(line);
  if (cp) return { cp: Number(cp[1]), mate: null };
  return null;
}

function parsePv(line: string): string | null {
  const match = /\bpv\s+(\S+)/.exec(line);
  return match ? match[1] : null;
}

function parseDepth(line: string): number {
  const match = /\bdepth\s+(\d+)/.exec(line);
  return match ? Number(match[1]) : 0;
}

export class UciEngine {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  name = "Stockfish";
  private listeners = new Set<LineListener>();
  private terminated = false;
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(scriptUrl: string, hashMb: number) {
    this.worker = new Worker(scriptUrl);
    this.worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      this.emit(`info string worker error: ${event.message || "unknown error"}`);
    };
    this.ready = this.init(hashMb);
    // Avoid an unhandled rejection when the UI never awaits ready().
    this.ready.catch(() => undefined);
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      // The Emscripten build posts one complete UCI line per message and does
      // not append a newline. Emit every non-empty segment immediately.
      for (const line of data.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) this.emit(trimmed);
      }
      return;
    }
    // Progress messages from the Emscripten loader are objects.
    if (data && typeof data === "object") {
      const payload = data as Record<string, unknown>;
      if (typeof payload.progress === "number") return;
    }
  }

  private emit(line: string): void {
    if (line.startsWith("id name ")) this.name = line.slice("id name ".length).trim();
    for (const listener of [...this.listeners]) listener(line);
  }

  private post(command: string): void {
    if (this.terminated) return;
    this.worker.postMessage(command);
  }

  private waitFor(pattern: RegExp, timeoutMs = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Stockfish did not answer ${pattern} within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      const listener = (line: string) => {
        if (!pattern.test(line)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(line);
      };
      this.listeners.add(listener);
    });
  }

  private async init(hashMb: number): Promise<void> {
    this.post("uci");
    await this.waitFor(/^uciok/, 60000);
    this.post(`setoption name Threads value 1`);
    this.post(`setoption name Hash value ${Math.max(16, hashMb)}`);
    this.post("isready");
    await this.waitFor(/^readyok/, 30000);
  }

  async evaluate(fen: string, depth: number): Promise<EngineEval | null> {
    await this.ready;
    if (this.terminated) return null;
    const searchDepth = Math.max(1, Math.trunc(depth));
    return new Promise<EngineEval | null>((resolve) => {
      let lastScore: { cp: number | null; mate: number | null } | null = null;
      let lastDepth = searchDepth;
      let pvFirst: string | null = null;
      let settled = false;

      const finish = (value: EngineEval | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), 120000);

      const listener = (line: string) => {
        if (line.startsWith("info ") && line.includes(" score ")) {
          const score = parseScore(line);
          if (score) {
            lastScore = score;
            lastDepth = parseDepth(line) || lastDepth;
            const pv = parsePv(line);
            if (pv) pvFirst = pv;
          }
          return;
        }
        if (!line.startsWith("bestmove")) return;
        const best = line.split(/\s+/)[1];
        const bestUci = pvFirst || (best && best !== "(none)" ? best : null);
        if (!lastScore) {
          finish(null);
          return;
        }
        const stm = sideToMove(fen);
        if (lastScore.mate !== null) {
          const whiteMate = stm === "white" ? lastScore.mate : -lastScore.mate;
          finish({
            cp: whiteMate > 0 ? 10000 : -10000,
            mate: whiteMate,
            best_uci: bestUci,
            depth: lastDepth,
          });
          return;
        }
        const rawCp = lastScore.cp ?? 0;
        const whiteCp = stm === "white" ? rawCp : -rawCp;
        finish({ cp: whiteCp, mate: null, best_uci: bestUci, depth: lastDepth });
      };

      this.listeners.add(listener);
      this.post(`position fen ${fen}`);
      this.post(`go depth ${searchDepth}`);
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.initTimer) clearTimeout(this.initTimer);
    try {
      this.worker.postMessage("quit");
    } catch {
      /* worker already gone */
    }
    this.worker.terminate();
    this.listeners.clear();
  }
}

export interface PoolOptions {
  workers?: number;
  hashMb?: number;
  scriptUrl?: string;
}

/**
 * A fixed set of single-threaded engines. Callers acquire one engine for a
 * whole game so that position searches never interleave on the same worker.
 */
export class StockfishPool {
  readonly workers: number;
  readonly hashMb: number;
  private engines: UciEngine[];
  private free: UciEngine[] = [];
  private waiters: Array<{ resolve: (engine: UciEngine) => void; reject: (error: Error) => void }> = [];
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.workers = Math.max(1, Math.trunc(options.workers || defaultWorkerCount()));
    this.hashMb = Math.max(16, Math.trunc(options.hashMb || defaultHashMb(this.workers)));
    const url = options.scriptUrl || engineScriptUrl();
    this.engines = Array.from({ length: this.workers }, () => new UciEngine(url, this.hashMb));
    this.free = [...this.engines];
  }

  get engineName(): string {
    return this.engines[0]?.name || "Stockfish";
  }

  async ready(): Promise<void> {
    await Promise.all(this.engines.map((engine) => engine.ready));
  }

  private acquire(): Promise<UciEngine> {
    if (this.closed) return Promise.reject(new Error("Stockfish pool is closed."));
    const engine = this.free.pop();
    if (engine) return Promise.resolve(engine);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private release(engine: UciEngine): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(engine);
    else this.free.push(engine);
  }

  async withEngine<T>(fn: (engine: UciEngine) => Promise<T>): Promise<T> {
    const engine = await this.acquire();
    try {
      return await fn(engine);
    } finally {
      this.release(engine);
    }
  }

  async evaluate(fen: string, depth: number): Promise<EngineEval | null> {
    return this.withEngine((engine) => engine.evaluate(fen, depth));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter.reject(new Error("Stockfish pool is closed."));
    }
    this.waiters = [];
    for (const engine of this.engines) engine.terminate();
  }
}
