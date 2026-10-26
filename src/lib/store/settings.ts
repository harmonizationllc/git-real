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

/** `base` with the edits still waiting for their timer laid on top, so a reply never undoes them. */
function withPending(base: Settings): Settings {
  return merge(base, Object.fromEntries([...pending].map(([s, e]) => [s, e.patch])));
}

/** Sends one section's edits; only ever called for a section that is in `pending`. */
async function send(section: Section): Promise<void> {
  const { patch, timer } = pending.get(section) as PendingEdit;
  clearTimeout(timer);
  pending.delete(section);
  try {
    const next = await updateSettings({ [section]: patch });
    lastKnown = next;
    useSettings.setState({ settings: withPending(next) });
  } catch (e) {
    useSettings.setState((s) => ({
      settings: withPending({ ...s.settings, [section]: lastKnown[section] }),
    }));
    useToasts
      .getState()
      .notify({ text: `Couldn't save settings: ${toAppError(e).message}`, variant: "error" });
  }
}

/** Every preference, hydrated synchronously from the settings Rust injected; settings.json is the only store. */
export const useSettings = create<SettingsState>()((set) => ({
  settings: lastKnown,
  setPref: (patch) => {
    set((s) => ({ settings: merge(s.settings, patch) }));
    for (const section of Object.keys(patch) as Section[]) {
      const prev = pending.get(section);
      if (prev) clearTimeout(prev.timer);
      pending.set(section, {
        patch: { ...prev?.patch, ...patch[section] },
        timer: setTimeout(() => void send(section), SAVE_DELAY_MS),
      });
    }
  },
  save: async (patch) => {
    const next = await updateSettings(patch);
    lastKnown = next;
    set({ settings: withPending(next) });
    return next;
  },
  reconcile: async () => {
    try {
      const next = await getSettings();
      lastKnown = next;
      set({ settings: withPending(next) });
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
