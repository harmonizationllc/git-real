import { create } from "zustand";
import { getSettings, toAppError, updateSettings } from "../ipc";
import type { Settings, SettingsPatch } from "../ipc";
import { useToasts } from "./toasts";

export const DIFF_FONT_MIN = 10;
export const DIFF_FONT_MAX = 24;
export const DIFF_FONT_DEFAULT = 13;
export const REFS_DEFAULT = 240;
export const SIDEBAR_DEFAULT = 320;

/** How long a section's quick edits coalesce before they are saved. */
const SAVE_DELAY_MS = 300;

/** The Rust defaults; `settingsDefaults.json` is the shared fixture that keeps them equal. */
export const DEFAULT_SETTINGS: Settings = {
  git: { executable: null },
  clone: { defaultDir: null, urlForm: "https" },
  tools: { editor: null, diffTool: null, mergeTool: null },
  appearance: { theme: "system", diffFontFamily: null, diffFontSize: DIFF_FONT_DEFAULT },
  diff: { mode: "split", ignoreWhitespace: false },
  layout: {
    refsWidth: REFS_DEFAULT,
    sidebarWidth: SIDEBAR_DEFAULT,
    tagsCollapsed: true,
    pullRequestsCollapsed: false,
    issuesCollapsed: true,
  },
  updates: { checkOnStartup: true },
  window: { width: 1280, height: 800, maximized: false },
};

/** The settings Rust injected before first paint, else the defaults; never throws. */
export function readInjectedSettings(): Settings {
  const injected = window.__GIT_REAL_SETTINGS__;
  // Rust guarantees the shape, so an object is trusted as-is.
  return typeof injected === "object" && injected !== null
    ? (injected as Settings)
    : DEFAULT_SETTINGS;
}

type Section = keyof Settings;

interface SettingsState {
  settings: Settings;
  /** Applies at once and saves after a short pause; a failed save reverts that section and toasts. */
  setPref(patch: SettingsPatch): void;
  /** Saves now and resolves to the normalised settings; errors propagate untouched. */
  save(patch: SettingsPatch): Promise<Settings>;
  /** Reloads from the backend; errors are swallowed. */
  reconcile(): Promise<void>;
  /** Sends every pending section now. */
  flush(): Promise<void>;
}

/** The last settings the backend confirmed; a failed save reverts its section to this. */
let lastKnown: Settings = readInjectedSettings();

interface PendingEdit {
  patch: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-section edits waiting for their timer. */
const pending = new Map<Section, PendingEdit>();

/** `base` with each section in `patch` merged field by field. */
function merge(base: Settings, patch: SettingsPatch): Settings {
  const next = { ...base } as Record<Section, unknown>;
  for (const section of Object.keys(patch) as Section[]) {
    next[section] = { ...base[section], ...patch[section] };
  }
  return next as Settings;
}

/** Each backend request takes the next number; replies are applied in this order only. */
let lastRequest = 0;
let lastApplied = 0;

/** setPref edits sent but not yet answered, by request number (ascending). */
const inFlight = new Map<number, SettingsPatch>();

/** Adopts `next` as server-known when its request is the newest answered; older replies are dropped. */
function adopt(request: number, next: Settings): void {
  if (request <= lastApplied) return;
  lastApplied = request;
  lastKnown = next;
}

/** Shows the server-known settings with in-flight, then still-pending, edits laid on top. */
function refresh(): void {
  const queued = Object.fromEntries([...pending].map(([s, e]) => [s, e.patch])) as SettingsPatch;
  useSettings.setState({ settings: [...inFlight.values(), queued].reduce(merge, lastKnown) });
}

/** Sends one section's edits; only ever called for a section that is in `pending`. */
async function send(section: Section): Promise<void> {
  const { patch, timer } = pending.get(section) as PendingEdit;
  clearTimeout(timer);
  pending.delete(section);
  const request = ++lastRequest;
  const sent = { [section]: patch };
  inFlight.set(request, sent);
  try {
    adopt(request, await updateSettings(sent));
  } catch (e) {
    useToasts
      .getState()
      .notify({ text: `Couldn't save settings: ${toAppError(e).message}`, variant: "error" });
  } finally {
    // A rejected edit leaves the overlay, so its section shows the server-known value again.
    inFlight.delete(request);
    refresh();
  }
}

/** Every preference, hydrated synchronously from the settings Rust injected; settings.json is the only store. */
export const useSettings = create<SettingsState>()(() => ({
  settings: lastKnown,
  setPref: (patch) => {
    for (const section of Object.keys(patch) as Section[]) {
      const prev = pending.get(section);
      if (prev) clearTimeout(prev.timer);
      pending.set(section, {
        patch: { ...prev?.patch, ...patch[section] },
        timer: setTimeout(() => void send(section), SAVE_DELAY_MS),
      });
    }
    refresh();
  },
  save: async (patch) => {
    const request = ++lastRequest;
    const next = await updateSettings(patch);
    adopt(request, next);
    refresh();
    return next;
  },
  reconcile: async () => {
    const request = ++lastRequest;
    try {
      adopt(request, await getSettings());
      refresh();
    } catch {
      // The injected settings stay in use.
    }
  },
  flush: async () => {
    await Promise.all([...pending.keys()].map(send));
  },
}));

/** Saves pending edits when the window goes away; returns the uninstaller. */
export function installFlushOnPagehide(): () => void {
  const onHide = () => void useSettings.getState().flush();
  window.addEventListener("pagehide", onHide);
  window.addEventListener("beforeunload", onHide);
  return () => {
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("beforeunload", onHide);
  };
}
