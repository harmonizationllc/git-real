// GR-29 Task 5: the one front-end settings store, hydrated from the injected settings.
//
// Each test loads a fresh module graph, because the store reads
// window.__GIT_REAL_SETTINGS__ and keeps its pending saves at module load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../ipc";
import fixture from "./settingsDefaults.json";

vi.mock(import("../ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

async function load() {
  const store = await import("./settings");
  const ipc = await import("../ipc");
  const { useToasts } = await import("./toasts");
  return {
    ...store,
    getSettings: vi.mocked(ipc.getSettings),
    updateSettings: vi.mocked(ipc.updateSettings),
    toasts: () => useToasts.getState().toasts,
  };
}

/** A deep copy of the defaults with one section's fields overridden. */
function withSection<S extends keyof Settings>(
  base: Settings,
  section: S,
  fields: Partial<Settings[S]>,
): Settings {
  const copy = structuredClone(base);
  copy[section] = { ...copy[section], ...fields };
  return copy;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  delete window.__GIT_REAL_SETTINGS__;
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__GIT_REAL_SETTINGS__;
});

describe("defaults", () => {
  it("defaults equal the shared fixture", async () => {
    const { DEFAULT_SETTINGS } = await load();
    expect(DEFAULT_SETTINGS).toEqual(fixture);
  });

  it("exports the clamp constants", async () => {
    const m = await load();
    expect([m.DIFF_FONT_MIN, m.DIFF_FONT_MAX, m.DIFF_FONT_DEFAULT]).toEqual([10, 24, 13]);
    expect([m.REFS_DEFAULT, m.SIDEBAR_DEFAULT]).toEqual([240, 320]);
  });
});

describe("readInjectedSettings", () => {
  it("readInjectedSettings uses the global when present and defaults otherwise", async () => {
    const { readInjectedSettings, DEFAULT_SETTINGS } = await load();
    expect(readInjectedSettings()).toEqual(DEFAULT_SETTINGS);
    const injected = withSection(DEFAULT_SETTINGS, "appearance", { theme: "dark" });
    window.__GIT_REAL_SETTINGS__ = injected;
    expect(readInjectedSettings()).toBe(injected);
  });

  it("readInjectedSettings ignores a non-object global", async () => {
    const { readInjectedSettings, DEFAULT_SETTINGS } = await load();
    for (const bad of [null, "settings", 42, true]) {
      window.__GIT_REAL_SETTINGS__ = bad;
      expect(readInjectedSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("the store starts from the injected settings at module load", async () => {
    const fixtureCopy = structuredClone(fixture) as Settings;
    const injected = withSection(fixtureCopy, "layout", { refsWidth: 300 });
    window.__GIT_REAL_SETTINGS__ = injected;
    const { useSettings } = await load();
    expect(useSettings.getState().settings).toEqual(injected);
  });
});

describe("setPref", () => {
  it("setPref applies locally at once and sends one coalesced patch per section after 300 ms", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(withSection(DEFAULT_SETTINGS, "layout", { refsWidth: 280 }));
    useSettings.getState().setPref({ layout: { refsWidth: 260 } });
    expect(useSettings.getState().settings.layout.refsWidth).toBe(260);
    await vi.advanceTimersByTimeAsync(200);
    useSettings.getState().setPref({ layout: { refsWidth: 280 } });
    expect(useSettings.getState().settings.layout.refsWidth).toBe(280);
    // The second call restarted the section's timer.
    await vi.advanceTimersByTimeAsync(299);
    expect(updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ layout: { refsWidth: 280 } });
  });

  it("setPref merges different fields of one section into one patch and sends each section separately", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(DEFAULT_SETTINGS);
    useSettings.getState().setPref({ layout: { refsWidth: 250 } });
    useSettings.getState().setPref({ layout: { tagsCollapsed: false }, diff: { mode: "unified" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenCalledWith({
      layout: { refsWidth: 250, tagsCollapsed: false },
    });
    expect(updateSettings).toHaveBeenCalledWith({ diff: { mode: "unified" } });
  });

  it("setPref reply replaces state (server clamp wins)", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const clamped = withSection(DEFAULT_SETTINGS, "layout", { refsWidth: 480 });
    updateSettings.mockResolvedValue(clamped);
    useSettings.getState().setPref({ layout: { refsWidth: 9999 } });
    expect(useSettings.getState().settings.layout.refsWidth).toBe(9999);
    await vi.advanceTimersByTimeAsync(300);
    expect(useSettings.getState().settings).toEqual(clamped);
  });

  it("a reply keeps local edits still waiting for their own timer", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    updateSettings.mockImplementation(async (patch) =>
      withSection(DEFAULT_SETTINGS, "appearance", patch.appearance ?? {}),
    );
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    await vi.advanceTimersByTimeAsync(100);
    useSettings.getState().setPref({ layout: { sidebarWidth: 400 } });
    await vi.advanceTimersByTimeAsync(200);
    // The appearance reply arrived while the layout edit was still pending.
    expect(useSettings.getState().settings.appearance.theme).toBe("dark");
    expect(useSettings.getState().settings.layout.sidebarWidth).toBe(400);
  });

  it("setPref rejection reverts only that section and toasts once", async () => {
    const { useSettings, updateSettings, toasts, DEFAULT_SETTINGS } = await load();
    const themed = withSection(DEFAULT_SETTINGS, "appearance", { theme: "light" });
    updateSettings.mockImplementation(async (patch) => {
      if (patch.layout) throw { kind: "io", message: "disk full" };
      return themed;
    });
    useSettings.getState().setPref({ appearance: { theme: "light" } });
    useSettings.getState().setPref({ layout: { refsWidth: 333 } });
    expect(useSettings.getState().settings.layout.refsWidth).toBe(333);
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    const { settings } = useSettings.getState();
    expect(settings.appearance.theme).toBe("light");
    expect(settings.layout).toEqual(DEFAULT_SETTINGS.layout);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      text: "Couldn't save settings: disk full",
      variant: "error",
    });
  });

  it("a rejection reverts to the last server-known value, not the defaults", async () => {
    const { useSettings, updateSettings, toasts, DEFAULT_SETTINGS } = await load();
    const saved = withSection(DEFAULT_SETTINGS, "layout", { refsWidth: 300 });
    updateSettings.mockResolvedValueOnce(saved);
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    await vi.advanceTimersByTimeAsync(300);
    updateSettings.mockRejectedValueOnce(new Error("locked"));
    useSettings.getState().setPref({ layout: { refsWidth: 350 } });
    await vi.advanceTimersByTimeAsync(300);
    expect(useSettings.getState().settings.layout.refsWidth).toBe(300);
    expect(toasts().map((t) => t.text)).toEqual(["Couldn't save settings: locked"]);
  });
});

/** A promise with its resolver, for replying to IPC calls in a chosen order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets awaited replies run their continuations. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("out-of-order replies", () => {
  it("replies resolved in reverse order keep both newer values, not the older snapshot", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    const second = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    const flushed = useSettings.getState().flush();
    expect(updateSettings).toHaveBeenNthCalledWith(1, { appearance: { theme: "dark" } });
    expect(updateSettings).toHaveBeenNthCalledWith(2, { layout: { refsWidth: 300 } });

    const both = withSection(
      withSection(DEFAULT_SETTINGS, "appearance", { theme: "dark" }),
      "layout",
      { refsWidth: 300 },
    );
    second.resolve(both);
    await settle();
    expect(useSettings.getState().settings).toEqual(both);

    // The first reply is an older snapshot: the theme is saved, the width not yet.
    first.resolve(withSection(DEFAULT_SETTINGS, "appearance", { theme: "dark" }));
    await flushed;
    expect(useSettings.getState().settings).toEqual(both);
  });

  it("a stale reply does not overwrite the server-known value a later revert uses", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    const second = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    useSettings.getState().setPref({ appearance: { theme: "light" } });
    const flushed = useSettings.getState().flush();
    second.resolve(
      withSection(withSection(DEFAULT_SETTINGS, "layout", { refsWidth: 300 }), "appearance", {
        theme: "light",
      }),
    );
    await settle();
    first.resolve(DEFAULT_SETTINGS);
    await flushed;

    updateSettings.mockRejectedValueOnce(new Error("locked"));
    useSettings.getState().setPref({ layout: { refsWidth: 350 } });
    await useSettings.getState().flush();
    expect(useSettings.getState().settings.layout.refsWidth).toBe(300);
    expect(useSettings.getState().settings.appearance.theme).toBe("light");
  });

  it("a reply arriving while a save is in flight keeps the in-flight value on screen", async () => {
    const { useSettings, updateSettings, getSettings, DEFAULT_SETTINGS } = await load();
    const reconciled = deferred<Settings>();
    const saved = deferred<Settings>();
    getSettings.mockReturnValueOnce(reconciled.promise);
    updateSettings.mockReturnValueOnce(saved.promise);
    const reconciling = useSettings.getState().reconcile();
    useSettings.getState().setPref({ layout: { sidebarWidth: 400 } });
    const flushed = useSettings.getState().flush();

    // The reconcile reply was read before the width save landed.
    reconciled.resolve(DEFAULT_SETTINGS);
    await reconciling;
    expect(useSettings.getState().settings.layout.sidebarWidth).toBe(400);

    saved.resolve(withSection(DEFAULT_SETTINGS, "layout", { sidebarWidth: 400 }));
    await flushed;
    expect(useSettings.getState().settings.layout.sidebarWidth).toBe(400);
  });

  it("an older reconcile reply arriving after a newer save is dropped", async () => {
    const { useSettings, updateSettings, getSettings, DEFAULT_SETTINGS } = await load();
    const reconciled = deferred<Settings>();
    getSettings.mockReturnValueOnce(reconciled.promise);
    const saved = withSection(DEFAULT_SETTINGS, "tools", { editor: "code" });
    updateSettings.mockResolvedValueOnce(saved);
    const reconciling = useSettings.getState().reconcile();
    await useSettings.getState().save({ tools: { editor: "code" } });
    reconciled.resolve(DEFAULT_SETTINGS);
    await reconciling;
    expect(useSettings.getState().settings).toEqual(saved);
  });
});

describe("flush", () => {
  it("flush sends pending patches immediately", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(DEFAULT_SETTINGS);
    useSettings
      .getState()
      .setPref({ layout: { refsWidth: 250 }, diff: { ignoreWhitespace: true } });
    await useSettings.getState().flush();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenCalledWith({ layout: { refsWidth: 250 } });
    expect(updateSettings).toHaveBeenCalledWith({ diff: { ignoreWhitespace: true } });
    // The timers were cleared: nothing is sent again later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it("flush with nothing pending sends nothing", async () => {
    const { useSettings, updateSettings } = await load();
    await useSettings.getState().flush();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("installFlushOnPagehide flushes on pagehide", async () => {
    const { useSettings, updateSettings, installFlushOnPagehide, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(DEFAULT_SETTINGS);
    const uninstall = installFlushOnPagehide();
    useSettings.getState().setPref({ layout: { sidebarWidth: 410 } });
    window.dispatchEvent(new Event("pagehide"));
    expect(updateSettings).toHaveBeenCalledWith({ layout: { sidebarWidth: 410 } });
    uninstall();
  });

  it("installFlushOnPagehide flushes on beforeunload and stops after uninstall", async () => {
    const { useSettings, updateSettings, installFlushOnPagehide, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(DEFAULT_SETTINGS);
    const uninstall = installFlushOnPagehide();
    useSettings.getState().setPref({ diff: { mode: "unified" } });
    window.dispatchEvent(new Event("beforeunload"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    uninstall();
    useSettings.getState().setPref({ diff: { mode: "split" } });
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});

describe("save", () => {
  it("save awaits, replaces state and rethrows", async () => {
    const { useSettings, updateSettings, toasts, DEFAULT_SETTINGS } = await load();
    const next = withSection(DEFAULT_SETTINGS, "tools", { editor: "code" });
    updateSettings.mockResolvedValueOnce(next);
    await expect(useSettings.getState().save({ tools: { editor: "code" } })).resolves.toBe(next);
    expect(updateSettings).toHaveBeenCalledWith({ tools: { editor: "code" } });
    expect(useSettings.getState().settings).toEqual(next);

    const err = { kind: "invalidSettings", message: "bad path" };
    updateSettings.mockRejectedValueOnce(err);
    await expect(useSettings.getState().save({ clone: { defaultDir: "rel" } })).rejects.toBe(err);
    expect(useSettings.getState().settings).toEqual(next);
    expect(toasts()).toHaveLength(0);
  });
});

describe("reconcile", () => {
  it("reconcile replaces state from getSettings and swallows errors", async () => {
    const { useSettings, getSettings, DEFAULT_SETTINGS } = await load();
    const disk = withSection(DEFAULT_SETTINGS, "updates", { checkOnStartup: false });
    getSettings.mockResolvedValueOnce(disk);
    await useSettings.getState().reconcile();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(useSettings.getState().settings).toEqual(disk);

    getSettings.mockRejectedValueOnce(new Error("gone"));
    await expect(useSettings.getState().reconcile()).resolves.toBeUndefined();
    expect(useSettings.getState().settings).toEqual(disk);
  });
});
