import { pyRound } from "./chess-utils";
import type { Profile } from "./types";

const BASE = "https://lichess.org";
const TOKEN_URL = "https://lichess.org/account/oauth/token";

const GAME_KEYS = [
  "id",
  "rated",
  "variant",
  "speed",
  "perf",
  "createdAt",
  "lastMoveAt",
  "status",
  "players",
  "winner",
  "opening",
  "moves",
  "clocks",
  "analysis",
  "clock",
  "initialFen",
] as const;

export class JobCancelled extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "JobCancelled";
  }
}

export class LichessError extends Error {
  status: number | null;
  hint: string | null;

  constructor(message: string, options: { status?: number | null; hint?: string | null } = {}) {
    super(message);
    this.name = "LichessError";
    this.status = options.status ?? null;
    this.hint = options.hint ?? null;
  }
}

function authHeaders(token: string | null | undefined, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const clean = (token || "").trim();
  if (clean) headers.Authorization = `Bearer ${clean}`;
  return headers;
}

export function errorForStatus(status: number, token: string | null, username?: string): LichessError {
  if (status === 401) {
    return new LichessError("Lichess rejected the API token.", {
      status,
      hint: `Create a personal token at ${TOKEN_URL} (no scopes are required) and paste it again.`,
    });
  }
  if (status === 403) {
    return new LichessError("Lichess refused access to this resource.", {
      status,
      hint: "Check that the token is valid and not restricted.",
    });
  }
  if (status === 404) {
    return new LichessError(`Lichess user '${username || "?"}' was not found.`, {
      status,
      hint: "Check the spelling of the username.",
    });
  }
  if (status === 429) {
    return new LichessError("Lichess rate limit reached.", {
      status,
      hint: "Wait a minute and try again. Avoid running several scans at once.",
    });
  }
  return new LichessError(`Lichess returned HTTP ${status}.`, { status });
}

async function requestJson(url: string, token: string | null): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { headers: authHeaders(token, "application/json") });
  } catch (error) {
    throw new LichessError(`Could not reach Lichess: ${(error as Error).message}`, {
      hint: "Check your connection and try again.",
    });
  }
  if (!response.ok) throw errorForStatus(response.status, token);
  try {
    return await response.json();
  } catch {
    throw new LichessError("Lichess returned an invalid response.");
  }
}

export interface AccountInfo {
  id: string | null;
  username: string | null;
  title: string | null;
  patron: boolean;
  scopes: string[];
}

export async function checkToken(token: string): Promise<AccountInfo> {
  const clean = (token || "").trim();
  if (!clean) {
    throw new LichessError("No API token supplied.", {
      hint: `Create one at ${TOKEN_URL} (no scopes required).`,
    });
  }
  const data = await requestJson(`${BASE}/api/account`, clean);
  return {
    id: data.id ?? null,
    username: data.username ?? null,
    title: data.title ?? null,
    patron: Boolean(data.patron),
    scopes: data.scopes || [],
  };
}

export async function getProfile(username: string, token: string | null = null): Promise<Profile> {
  const name = (username || "").trim();
  if (!name) throw new LichessError("Enter a Lichess username.");
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/user/${encodeURIComponent(name)}`, {
      headers: authHeaders(token, "application/json"),
    });
  } catch (error) {
    throw new LichessError(`Could not reach Lichess: ${(error as Error).message}`, {
      hint: "Check your connection and try again.",
    });
  }
  if (response.status === 404) {
    throw new LichessError(`Lichess user '${name}' was not found.`, {
      status: 404,
      hint: "Check the spelling of the username.",
    });
  }
  if (!response.ok) throw errorForStatus(response.status, token, name);
  let raw: any;
  try {
    raw = await response.json();
  } catch {
    throw new LichessError("Lichess returned an invalid profile response.");
  }

  const perfs: Profile["perfs"] = {};
  for (const [key, value] of Object.entries(raw.perfs || {})) {
    const entry = value as Record<string, any>;
    if (entry && Number(entry.games || 0) > 0) {
      perfs[key] = {
        rating: entry.rating ?? null,
        games: entry.games ?? null,
        prog: entry.prog ?? null,
        prov: Boolean(entry.prov),
      };
    }
  }
  const playTime = raw.playTime || {};
  return {
    username: raw.username || name,
    id: raw.id || name.toLowerCase(),
    title: raw.title ?? null,
    patron: Boolean(raw.patron),
    created_at: raw.createdAt ?? null,
    seen_at: raw.seenAt ?? null,
    url: raw.url || `https://lichess.org/@/${name}`,
    perfs,
    counts: raw.count || {},
    play_time_hours: pyRound(Number(playTime.total || 0) / 3600, 1),
    profile: raw.profile || {},
  };
}

export interface IterGamesOptions {
  maxGames?: number;
  perf?: string;
  includeUnrated?: boolean;
  token?: string | null;
  totalHint?: number | null;
  signal?: AbortSignal | null;
  cancelCheck?: (() => boolean) | null;
  onGame?: (game: Record<string, any>, index: number) => void;
  onProgress?: (count: number, hint: number | null) => void;
}

export interface IterGamesResult {
  count: number;
  warning: string | null;
  started: boolean;
}

function trimGame(raw: Record<string, any>): Record<string, any> {
  const trimmed: Record<string, any> = {};
  for (const key of GAME_KEYS) {
    if (key in raw) trimmed[key] = raw[key];
  }
  return trimmed;
}

/**
 * Stream a user's games as NDJSON using the browser fetch API.
 *
 * Lichess allows CORS on this endpoint for authenticated requests. We never set
 * User-Agent (browsers forbid it) and the token is only used for this request.
 */
export async function iterGames(
  username: string,
  options: IterGamesOptions = {},
): Promise<IterGamesResult> {
  const {
    maxGames = 50,
    perf = "all",
    includeUnrated = false,
    token = null,
    totalHint = null,
    signal = null,
    cancelCheck = null,
    onGame,
    onProgress,
  } = options;

  const params = new URLSearchParams({
    clocks: "true",
    evals: "true",
    accuracy: "true",
    opening: "true",
    moves: "true",
    pgnInJson: "false",
  });
  if (maxGames && maxGames > 0) params.set("max", String(maxGames));
  if (perf && perf !== "all") params.set("perfType", perf);
  if (!includeUnrated) params.set("rated", "true");

  const url = `${BASE}/api/games/user/${encodeURIComponent(username)}?${params.toString()}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(token, "application/x-ndjson"),
      signal: signal || undefined,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new JobCancelled();
    throw new LichessError(`Could not download games: ${(error as Error).message}`, {
      hint: "Check your connection and try again.",
    });
  }
  if (!response.ok) throw errorForStatus(response.status, token, username);
  if (!response.body) {
    throw new LichessError("This browser cannot stream the Lichess export.", {
      hint: "Try a current version of Chrome, Edge, Firefox or Safari.",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  let warning: string | null = null;
  let started = false;

  const handleLine = (line: string) => {
    if (!line) return;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || !raw.id) return;
    onGame?.(trimGame(raw), count);
    count += 1;
    onProgress?.(count, totalHint);
  };

  try {
    started = true;
    while (true) {
      if (cancelCheck?.()) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new JobCancelled();
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (maxGames && count >= maxGames) break;
      }
      if (maxGames && count >= maxGames) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    if (!(maxGames && count >= maxGames) && buffer.trim()) handleLine(buffer.trim());
  } catch (error) {
    if (error instanceof JobCancelled) throw error;
    if ((error as Error).name === "AbortError") throw new JobCancelled();
    if (count === 0) {
      throw new LichessError(`Could not download games: ${(error as Error).message}`, {
        hint: "Check your connection and try again.",
      });
    }
    warning = `Download stopped after ${count} games: ${(error as Error).message}`;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  return { count, warning, started };
}

// ---------------------------------------------------------------------------
// Lichess cloud evaluation (optional mode)
// ---------------------------------------------------------------------------

interface CloudPayload {
  cp: number | null;
  mate: number | null;
  best_uci: string | null;
  depth: number;
}

const CLOUD_CACHE_KEY = "knightwatch:cloud-eval:v1";

export class CloudEvaluator {
  private cache = new Map<string, CloudPayload | null>();
  private minInterval: number;
  private lastRequest = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(minInterval = 1050) {
    this.minInterval = minInterval;
  }

  private async loadCache(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = localStorage.getItem(CLOUD_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, CloudPayload | null>;
      for (const [fen, payload] of Object.entries(parsed)) this.cache.set(fen, payload);
    } catch {
      /* ignore corrupt cache */
    }
  }

  private persist(): void {
    try {
      const entries = [...this.cache.entries()].slice(-4000);
      localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* storage may be full or disabled */
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async evaluate(fen: string): Promise<Record<string, any> | null> {
    await this.loadCache();
    if (this.cache.has(fen)) return this.cache.get(fen) || null;

    // Serialize network requests so the shared cloud service is not hammered.
    const task = this.chain.then(async () => {
      if (this.cache.has(fen)) return this.cache.get(fen) || null;
      const wait = this.minInterval - (Date.now() - this.lastRequest);
      if (wait > 0) await this.sleep(wait);
      this.lastRequest = Date.now();
      let response: Response;
      try {
        const params = new URLSearchParams({ fen, multiPv: "1" });
        response = await fetch(`${BASE}/api/cloud-eval?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
      } catch {
        return null;
      }
      if (response.status === 404) {
        this.cache.set(fen, null);
        return null;
      }
      if (response.status === 429) {
        await this.sleep(4000);
        return null;
      }
      if (!response.ok) return null;
      let data: any;
      try {
        data = await response.json();
      } catch {
        return null;
      }
      const pvs = data.pvs || [];
      if (!pvs.length) {
        this.cache.set(fen, null);
        return null;
      }
      const pv = pvs[0] || {};
      const cp = pv.cp ?? null;
      const mate = pv.mate ?? null;
      if (cp === null && mate === null) {
        this.cache.set(fen, null);
        return null;
      }
      const moves = String(pv.moves || "").split(/\s+/).filter(Boolean);
      const payload: CloudPayload = {
        cp: cp !== null ? Math.trunc(Number(cp)) : null,
        mate: mate !== null ? Math.trunc(Number(mate)) : null,
        best_uci: moves[0] || null,
        depth: Math.trunc(Number(data.depth || 0)),
      };
      this.cache.set(fen, payload);
      this.persist();
      return payload;
    });

    this.chain = task.catch(() => null);
    return task;
  }
}
