/**
 * Chess.com public API client.
 *
 * Chess.com exposes read-only, CORS-enabled endpoints. No token is required
 * and nothing is sent anywhere except directly to api.chess.com.
 */

const API_BASE = "https://api.chess.com/pub";
const MAX_MONTHS = 12;

export class ChessComError extends Error {
  hint: string | null;

  constructor(message: string, options: { hint?: string | null } = {}) {
    super(message);
    this.name = "ChessComError";
    this.hint = options.hint ?? null;
  }
}

export interface ChessComProfile {
  username: string;
  player_id?: number;
  name?: string;
  title?: string;
  url?: string;
  avatar?: string;
  status?: string;
  followers?: number;
  country?: string;
  joined?: number;
  last_online?: number;
  [key: string]: unknown;
}

export interface ChessComGame {
  url: string;
  pgn: string;
  time_control: string;
  time_class: string;
  rules: string;
  rated: boolean;
  end_time: number;
  white: { username: string; rating?: number; result?: string };
  black: { username: string; rating?: number; result?: string };
  uuid?: string;
  [key: string]: unknown;
}

export interface ChessComFetchOptions {
  username: string;
  maxGames: number;
  timeClass: string;
  includeUnrated: boolean;
  signal?: AbortSignal;
  onProgress?: (found: number, months: number) => void;
}

export interface ChessComFetchResult {
  games: ChessComGame[];
  months: number;
  warning: string | null;
}

function userPath(username: string): string {
  return `${API_BASE}/player/${encodeURIComponent(username.trim().toLowerCase())}`;
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ChessComError("Could not reach Chess.com.", {
      hint: "Check your connection or any extension that blocks api.chess.com, then try again.",
    });
  }
  if (response.status === 404) {
    throw new ChessComError("That Chess.com player was not found.", {
      hint: "Check the username. Chess.com usernames are not case-sensitive.",
    });
  }
  if (response.status === 429) {
    throw new ChessComError("Chess.com is rate-limiting requests.", {
      hint: "Wait a minute and try again, or scan fewer games.",
    });
  }
  if (!response.ok) {
    throw new ChessComError(`Chess.com returned HTTP ${response.status}.`, {
      hint: "Try again in a moment. If it keeps failing, the public API may be unavailable.",
    });
  }
  return (await response.json()) as T;
}

export async function getChessComProfile(
  username: string,
  signal?: AbortSignal,
): Promise<ChessComProfile> {
  if (!username.trim()) throw new ChessComError("Enter a Chess.com username.");
  return requestJson<ChessComProfile>(userPath(username), signal);
}

export async function getChessComArchives(
  username: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const payload = await requestJson<{ archives?: string[] }>(
    `${userPath(username)}/games/archives`,
    signal,
  );
  return Array.isArray(payload.archives) ? payload.archives : [];
}

export function chessComSpeed(timeClass: string): string | null {
  const key = String(timeClass || "").toLowerCase();
  if (key === "daily") return "correspondence";
  if (key === "ultrabullet") return "ultraBullet";
  if (["bullet", "blitz", "rapid", "classical", "correspondence"].includes(key)) return key;
  return null;
}

/**
 * Walk backwards through monthly archives until enough matching games are
 * collected. Chess.com returns games oldest-first within a month, so each
 * archive is sorted newest-first before selection.
 */
export async function fetchChessComGames(
  options: ChessComFetchOptions,
): Promise<ChessComFetchResult> {
  const { username, timeClass, includeUnrated, signal, onProgress } = options;
  const target = Math.max(1, Math.min(500, Math.trunc(options.maxGames) || 50));

  const archives = await getChessComArchives(username, signal);
  if (!archives.length) {
    throw new ChessComError("No public games were found for that player.", {
      hint: "The account may be new, closed, or have no public games.",
    });
  }

  const ordered = [...archives].reverse();
  const wanted = String(timeClass || "all").toLowerCase();
  const selected: ChessComGame[] = [];
  let months = 0;

  for (const archiveUrl of ordered) {
    if (selected.length >= target) break;
    if (months >= MAX_MONTHS) break;
    if (signal?.aborted) break;

    const payload = await requestJson<{ games?: ChessComGame[] }>(archiveUrl, signal);
    months += 1;
    const games = Array.isArray(payload.games) ? payload.games : [];
    const eligible = games
      .filter((game) => String(game.rules || "chess").toLowerCase() === "chess")
      .filter((game) => includeUnrated || game.rated !== false)
      .filter((game) => wanted === "all" || String(game.time_class || "").toLowerCase() === wanted)
      .filter((game) => typeof game.pgn === "string" && game.pgn.trim().length > 0)
      .sort((a, b) => Number(b.end_time || 0) - Number(a.end_time || 0));

    for (const game of eligible) {
      if (selected.length >= target) break;
      selected.push(game);
    }
    onProgress?.(selected.length, months);
  }

  let warning: string | null = null;
  if (selected.length < target) {
    const reason = months >= MAX_MONTHS ? `only the last ${MAX_MONTHS} months were checked` : "no older archives were available";
    warning = `Found ${selected.length} of ${target} requested games (${reason}).`;
  }

  return { games: selected, months, warning };
}
