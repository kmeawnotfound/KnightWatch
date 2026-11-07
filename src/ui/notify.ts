import { els } from "./els";
import { setText } from "./dom";

interface ErrorLike {
  message?: string;
  hint?: string;
}

export function showError(error: unknown, title = "Something went wrong"): void {
  const err = (error || {}) as ErrorLike;
  setText(els.errorTitle, title);
  setText(els.errorText, err.message ? err.message : String(error));
  if (err.hint) {
    els.errorText.textContent = `${els.errorText.textContent || ""} ${err.hint}`;
  }
  els.errorBanner.classList.remove("hidden");
  els.errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function clearError(): void {
  els.errorBanner.classList.add("hidden");
}

let toastTimer: number | null = null;

export function toast(message: string, isError = false): void {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.remove("hidden");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 4200);
}
