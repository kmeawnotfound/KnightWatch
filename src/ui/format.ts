export function fmtNumber(value: unknown, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtInt(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Math.round(Number(value)).toLocaleString();
}

export function fmtPct(value: unknown, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return `${Number(value).toFixed(digits)}%`;
}

export function fmtPawns(cp: unknown): string {
  if (cp === null || cp === undefined) return "—";
  const pawns = Number(cp) / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

export function fmtTime(seconds: unknown): string {
  if (seconds === null || seconds === undefined) return "";
  const s = Number(seconds);
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

export function fmtDuration(seconds: unknown): string {
  if (seconds === null || seconds === undefined) return "";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

export function scoreColor(score: number): string {
  if (score < 30) return "#57d38c";
  if (score < 45) return "#a3d977";
  if (score < 60) return "#f5b84c";
  if (score < 75) return "#f08c4c";
  if (score < 88) return "#ff6b6b";
  return "#e5484d";
}

export function scoreClass(score: number): string {
  if (score < 45) return "good";
  if (score < 70) return "warn";
  return "bad";
}

export function titleCase(value: unknown): string {
  if (!value) return "—";
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
