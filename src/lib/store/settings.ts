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
    branchesHeight: null,
    stashesHeight: null,
    tagsHeight: null,
    worktreesCollapsed: false,
    worktreesHeight: null,
    pullRequestsHeight: null,
  },
  updates: { checkOnStartup: true },
  shortcuts: { bindings: {} },
  window: { width: 1280, height: 800, maximized: false },
};

/** The settings Rust injected before first paint, else the defaults; never throws. */
export function readInjectedSettings(): Settings {
  const injected = window.__GIT_REAL_SETTINGS__;
  // Rust guarantees the shape, so an object is trusted as-is.
  return typeof injected === "object" && injected !== null && !Array.isArray(injected)
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
  patch: Partial<Settings[Section]>;
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

/** Numbers each queued setPref request; the queue sends them in this order. */
let lastRequest = 0;

/** setPref edits queued or sent but not yet answered, by request number (ascending). */
const inFlight = new Map<number, SettingsPatch>();

/** True while one backend request is outstanding. */
let busy = false;

/** Requests waiting for the outstanding one to settle, oldest first. */
const waiting: Array<() => void> = [];

/**
 * Runs `job` once every earlier request has settled, so Rust applies writes in the order they
 * were made. When the queue is idle the job starts synchronously (a pagehide flush relies on it).
 */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      busy = true;
      job()
        .then(resolve, reject)
        .finally(() => {
          busy = false;
          waiting.shift()?.();
        });
    };
    if (busy) waiting.push(run);
    else run();
  });
}

/** Shows the server-known settings with in-flight, then still-pending, edits laid on top. */
function refresh(): void {
  const queued = Object.fromEntries([...pending].map(([s, e]) => [s, e.patch])) as SettingsPatch;
  useSettings.setState({ settings: [...inFlight.values(), queued].reduce(merge, lastKnown) });
}

/** Takes the named sections out of `pending` as one patch; each must be in `pending`. */
function takePending(sections: Section[]): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const section of sections) {
    const { patch: fields, timer } = pending.get(section) as PendingEdit;
    clearTimeout(timer);
    pending.delete(section);
    patch[section] = fields;
  }
  return patch as SettingsPatch;
}

/** Queues one setPref request; a rejection reverts the sections it carried and toasts once. */
function send(patch: SettingsPatch): Promise<void> {
  const request = ++lastRequest;
  inFlight.set(request, patch);
  return enqueue(async () => {
    try {
      lastKnown = await updateSettings(patch);
    } catch (e) {
      useToasts
        .getState()
        .notify({ text: `Couldn't save settings: ${toAppError(e).message}`, variant: "error" });
    } finally {
      // A rejected edit leaves the overlay, so its sections show the server-known value again.
      inFlight.delete(request);
      refresh();
    }
  });
}

/** Every preference, hydrated synchronously from the settings Rust injected; settings.json is the only store. */
export const useSettings = create<SettingsState>()(() => ({
  settings: lastKnown,
  setPref: (patch) => {
    for (const section of Object.keys(patch) as Section[]) {
      if (Object.keys(patch[section] ?? {}).length === 0) continue;
      const prev = pending.get(section);
      if (prev) clearTimeout(prev.timer);
      pending.set(section, {
        patch: { ...prev?.patch, ...patch[section] },
        timer: setTimeout(() => void send(takePending([section])), SAVE_DELAY_MS),
      });
    }
    refresh();
  },
  save: (patch) =>
    enqueue(async () => {
      const next = await updateSettings(patch);
      lastKnown = next;
      refresh();
      return next;
    }),
  reconcile: async () => {
    try {
      await enqueue(async () => {
        lastKnown = await getSettings();
        refresh();
      });
    } catch {
      // The injected settings stay in use.
    }
  },
  flush: async () => {
    const sections = [...pending.keys()];
    // With nothing pending, the empty job still waits for whatever is already queued.
    await (sections.length > 0 ? send(takePending(sections)) : enqueue(async () => {}));
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
