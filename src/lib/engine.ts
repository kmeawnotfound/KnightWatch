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

export const ENGINE_SCRIPT = "engine/stockfish-19-lite-single-v2.js";

export function engineScriptUrl(): string {
  return new URL(ENGINE_SCRIPT, document.baseURI).href;
}

export function defaultWorkerCount(): number {
  const cores =
    typeof navigator !== "undefined" && Number(navigator.hardwareConcurrency)
      ? Number(navigator.hardwareConcurrency)
      : 4;
  // Low-memory devices struggle to start eight WASM workers, so cap by RAM
  // when the browser reports it.
  const memoryGb =
    typeof navigator !== "undefined" && Number((navigator as any).deviceMemory)
      ? Number((navigator as any).deviceMemory)
      : 8;
  const cap = memoryGb <= 4 ? 4 : 8;
  return Math.max(1, Math.min(cap, cores - 1));
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
  private errorWaiters = new Set<(error: Error) => void>();
  private initError: Error | null = null;
  private terminated = false;

  constructor(scriptUrl: string, hashMb: number) {
    this.worker = new Worker(scriptUrl);
    this.worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      const detail = event.message || "unknown error";
      const error = new Error(`Stockfish worker failed to start (${detail}).`);
      this.initError = error;
      for (const reject of [...this.errorWaiters]) reject(error);
      this.errorWaiters.clear();
      this.emit(`info string worker error: ${detail}`);
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

  private waitFor(pattern: RegExp, timeoutMs = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.initError) {
        reject(this.initError);
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.errorWaiters.delete(onError);
      };
      const listener = (line: string) => {
        if (!pattern.test(line)) return;
        cleanup();
        resolve(line);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Stockfish did not answer ${pattern} within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.listeners.add(listener);
      this.errorWaiters.add(onError);
    });
  }

  private async init(hashMb: number): Promise<void> {
    this.post("uci");
    await this.waitFor(/^uciok/, 20000);
    this.post(`setoption name Threads value 1`);
    this.post(`setoption name Hash value ${Math.max(16, hashMb)}`);
    this.post("isready");
    await this.waitFor(/^readyok/, 15000);
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

  /** Ask the current search to finish early. The worker stays alive. */
  stop(): void {
    if (!this.terminated) this.post("stop");
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    for (const reject of [...this.errorWaiters]) {
      reject(new Error("Stockfish worker was terminated."));
    }
    this.errorWaiters.clear();
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

  async ready(onProgress?: (done: number, total: number) => void): Promise<void> {
    const total = this.engines.length;
    let done = 0;
    await Promise.all(
      this.engines.map(async (engine) => {
        await engine.ready;
        done += 1;
        onProgress?.(done, total);
      }),
    );
  }

  /** Stop in-flight searches without tearing the pool down. */
  stopAll(): void {
    for (const engine of this.engines) engine.stop();
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

// ---------------------------------------------------------------------------
// Session-wide pool
//
// Booting eight WASM workers is the slowest part of a scan, so the pool is
// created once and reused. It is released after a short idle period to give
// the browser its memory back.
// ---------------------------------------------------------------------------

type PoolProgressListener = (done: number, total: number) => void;

const progressListeners = new Set<PoolProgressListener>();
let progressDone = 0;
let progressTotal = 0;
let sharedPool: StockfishPool | null = null;
let sharedReady: Promise<StockfishPool> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let poolReady = false;

function emitPoolProgress(done: number, total: number): void {
  progressDone = done;
  progressTotal = total;
  for (const listener of [...progressListeners]) listener(done, total);
}

/** Observe worker start-up. Fires immediately with the current state. */
export function onEnginePoolProgress(listener: PoolProgressListener): () => void {
  progressListeners.add(listener);
  if (progressTotal > 0) listener(progressDone, progressTotal);
  return () => {
    progressListeners.delete(listener);
  };
}

async function preloadEngineWasm(scriptUrl: string): Promise<void> {
  // Eight workers requesting the same 1.8 MB file at once can each miss the
  // HTTP cache on a first visit. Fetch it once so they all hit the cache.
  const wasmUrl = scriptUrl.replace(/\.js(?:\?.*)?$/, ".wasm");
  try {
    await fetch(wasmUrl, { cache: "force-cache" });
  } catch {
    /* Workers will fetch it themselves if this fails. */
  }
}

/**
 * Return the shared engine pool, starting it on first use. Repeated calls
 * while it is booting return the same promise.
 */
export function getEnginePool(): Promise<StockfishPool> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (sharedReady) return sharedReady;

  const url = engineScriptUrl();
  const startedGeneration = generation;
  const promise = preloadEngineWasm(url)
    .then(() => {
      if (startedGeneration !== generation) {
        throw new Error("Stockfish pool was closed during startup.");
      }
      const pool = new StockfishPool({ scriptUrl: url });
      sharedPool = pool;
      poolReady = false;
      progressDone = 0;
      progressTotal = pool.workers;
      return pool.ready((done, total) => emitPoolProgress(done, total)).then(() => {
        poolReady = true;
        return pool;
      });
    })
    .catch((error) => {
      if (sharedReady === promise) {
        sharedReady = null;
        sharedPool = null;
      }
      poolReady = false;
      throw error;
    });

  sharedReady = promise;
  return promise;
}

/** True when the shared pool has finished booting and is safe to use now. */
export function isEnginePoolReady(): boolean {
  return poolReady;
}

/** Keep the warm pool around briefly, then release its memory. */
export function releaseEnginePool(idleMs = 120_000): void {
  if (!sharedPool && !sharedReady) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeEnginePool(), idleMs);
}

export function closeEnginePool(): void {
  generation += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  sharedPool?.close();
  sharedPool = null;
  sharedReady = null;
  poolReady = false;
  progressDone = 0;
  progressTotal = 0;
}
