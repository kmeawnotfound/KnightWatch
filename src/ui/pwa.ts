import { toast } from "./notify";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISSED_KEY = "knightwatch:install-dismissed";

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Private mode: the prompt just shows again next visit. */
  }
}

/**
 * Register the offline worker in production builds only. During `npm run dev`
 * a service worker would cache stale modules and make edits confusing.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        const announceUpdate = () => {
          if (!navigator.serviceWorker.controller) return;
          toast("A new version is ready. Reload to update.");
        };

        if (registration.waiting) announceUpdate();

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed") announceUpdate();
          });
        });

        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update();
        });
      })
      .catch(() => {
        /* No offline support (unsupported browser or blocked storage). */
      });
  });
}

function initInstallButton(): void {
  const button = document.getElementById("install-app") as HTMLButtonElement | null;
  if (!button) return;

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  if (standalone || storageGet(DISMISSED_KEY) === "1") return;

  let promptEvent: InstallPromptEvent | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    promptEvent = event as InstallPromptEvent;
    button.classList.remove("hidden");
  });

  button.addEventListener("click", () => {
    if (!promptEvent) return;
    const pending = promptEvent;
    promptEvent = null;
    button.classList.add("hidden");
    void (async () => {
      try {
        await pending.prompt();
        const choice = await pending.userChoice;
        if (choice.outcome === "dismissed") storageSet(DISMISSED_KEY, "1");
      } catch {
        /* The browser withdrew the prompt; try again on the next visit. */
      }
    })();
  });

  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    button.classList.add("hidden");
    toast("KnightWatch installed. Saved reports and the engine now work offline.");
  });
}

function initConnectivityNotice(): void {
  const announce = () => {
    if (!navigator.onLine) {
      toast("You're offline. Saved reports and cached analysis still work.");
    }
  };
  window.addEventListener("offline", announce);
  if (!navigator.onLine) window.setTimeout(announce, 1200);
}

export function initPwa(): void {
  registerServiceWorker();
  initInstallButton();
  initConnectivityNotice();
}
