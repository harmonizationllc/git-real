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

  it("readInjectedSettings ignores an array global", async () => {
    const { readInjectedSettings, DEFAULT_SETTINGS } = await load();
    window.__GIT_REAL_SETTINGS__ = [] as unknown as Settings;
    expect(readInjectedSettings()).toEqual(DEFAULT_SETTINGS);
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

  it("setPref with an empty section arms no timer and sends nothing", async () => {
    const { useSettings, updateSettings } = await load();
    useSettings.getState().setPref({ layout: {}, diff: undefined });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSettings).not.toHaveBeenCalled();
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

/** A promise with its resolver and rejecter, for replying to IPC calls at a chosen time. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets awaited replies run their continuations. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("one request at a time", () => {
  it("two sections set in the same tick keep one updateSettings in flight at a time", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise).mockResolvedValue(DEFAULT_SETTINGS);
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    await vi.advanceTimersByTimeAsync(300);
    // Both timers fired, but the second request waits for the first reply.
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenLastCalledWith({ appearance: { theme: "dark" } });
    first.resolve(withSection(DEFAULT_SETTINGS, "appearance", { theme: "dark" }));
    await settle();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenLastCalledWith({ layout: { refsWidth: 300 } });
  });

  it("serialised requests end with the theme dark and the width 300, whatever the reply timing", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const light = withSection(DEFAULT_SETTINGS, "appearance", { theme: "light" });
    useSettings.setState({ settings: light });
    const first = deferred<Settings>();
    const second = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    await vi.advanceTimersByTimeAsync(300);

    // Rust applies the theme first, because the width request has not been sent yet.
    const dark = withSection(light, "appearance", { theme: "dark" });
    await vi.advanceTimersByTimeAsync(50);
    first.resolve(dark);
    await settle();
    expect(useSettings.getState().settings.appearance.theme).toBe("dark");
    expect(useSettings.getState().settings.layout.refsWidth).toBe(300);

    const both = withSection(dark, "layout", { refsWidth: 300 });
    await vi.advanceTimersByTimeAsync(500);
    second.resolve(both);
    await settle();
    expect(useSettings.getState().settings).toEqual(both);
  });

  it("a rejected request does not block the queue", async () => {
    const { useSettings, updateSettings, toasts, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    const widened = withSection(DEFAULT_SETTINGS, "layout", { refsWidth: 300 });
    updateSettings.mockReturnValueOnce(first.promise).mockResolvedValueOnce(widened);
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    first.reject({ kind: "io", message: "disk full" });
    await settle();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenLastCalledWith({ layout: { refsWidth: 300 } });
    expect(useSettings.getState().settings).toEqual(widened);
    expect(toasts().map((t) => t.text)).toEqual(["Couldn't save settings: disk full"]);
  });

  it("a pending edit on a rejected section is still sent afterwards", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    const saved = withSection(DEFAULT_SETTINGS, "layout", { sidebarWidth: 400 });
    updateSettings.mockReturnValueOnce(first.promise).mockResolvedValueOnce(saved);
    useSettings.getState().setPref({ layout: { refsWidth: 300 } });
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    // The same section is edited again while the first request is in flight.
    useSettings.getState().setPref({ layout: { sidebarWidth: 400 } });
    expect(useSettings.getState().settings.layout).toMatchObject({
      refsWidth: 300,
      sidebarWidth: 400,
    });

    first.reject({ kind: "io", message: "disk full" });
    await settle();
    // The rejected field reverts; the newer pending field stays on screen.
    expect(useSettings.getState().settings.layout).toMatchObject({
      refsWidth: DEFAULT_SETTINGS.layout.refsWidth,
      sidebarWidth: 400,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenLastCalledWith({ layout: { sidebarWidth: 400 } });
    expect(useSettings.getState().settings).toEqual(saved);
  });

  it("a reconcile reply read before a queued save keeps the queued value on screen", async () => {
    const { useSettings, updateSettings, getSettings, DEFAULT_SETTINGS } = await load();
    const reconciled = deferred<Settings>();
    getSettings.mockReturnValueOnce(reconciled.promise);
    const saved = withSection(DEFAULT_SETTINGS, "layout", { sidebarWidth: 400 });
    updateSettings.mockResolvedValueOnce(saved);
    const reconciling = useSettings.getState().reconcile();
    useSettings.getState().setPref({ layout: { sidebarWidth: 400 } });
    const flushed = useSettings.getState().flush();
    // The flush waits behind the reconcile read.
    expect(updateSettings).not.toHaveBeenCalled();

    reconciled.resolve(DEFAULT_SETTINGS);
    await reconciling;
    expect(useSettings.getState().settings.layout.sidebarWidth).toBe(400);

    await flushed;
    expect(updateSettings).toHaveBeenCalledWith({ layout: { sidebarWidth: 400 } });
    expect(useSettings.getState().settings).toEqual(saved);
  });

  it("a save queued behind a reconcile is applied after the reconcile reply", async () => {
    const { useSettings, updateSettings, getSettings, DEFAULT_SETTINGS } = await load();
    const reconciled = deferred<Settings>();
    getSettings.mockReturnValueOnce(reconciled.promise);
    const saved = withSection(DEFAULT_SETTINGS, "tools", { editor: "code" });
    updateSettings.mockResolvedValueOnce(saved);
    const reconciling = useSettings.getState().reconcile();
    const saving = useSettings.getState().save({ tools: { editor: "code" } });
    expect(updateSettings).not.toHaveBeenCalled();
    reconciled.resolve(DEFAULT_SETTINGS);
    await reconciling;
    await expect(saving).resolves.toBe(saved);
    expect(useSettings.getState().settings).toEqual(saved);
  });
});

describe("flush", () => {
  it("flush sends every pending section in one request", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    updateSettings.mockResolvedValue(DEFAULT_SETTINGS);
    useSettings
      .getState()
      .setPref({ layout: { refsWidth: 250 }, diff: { ignoreWhitespace: true } });
    await useSettings.getState().flush();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      layout: { refsWidth: 250 },
      diff: { ignoreWhitespace: true },
    });
    // The timers were cleared: nothing is sent again later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("a rejected flush reverts every section it carried and toasts once", async () => {
    const { useSettings, updateSettings, toasts, DEFAULT_SETTINGS } = await load();
    updateSettings.mockRejectedValueOnce(new Error("locked"));
    useSettings.getState().setPref({ layout: { refsWidth: 250 }, diff: { mode: "unified" } });
    await useSettings.getState().flush();
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(toasts().map((t) => t.text)).toEqual(["Couldn't save settings: locked"]);
  });

  it("flush with nothing pending waits for the request in flight and sends nothing more", async () => {
    const { useSettings, updateSettings, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise);
    useSettings.getState().setPref({ diff: { mode: "unified" } });
    await vi.advanceTimersByTimeAsync(300);
    let done = false;
    const flushed = useSettings
      .getState()
      .flush()
      .then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    first.resolve(DEFAULT_SETTINGS);
    await flushed;
    expect(updateSettings).toHaveBeenCalledTimes(1);
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

  it("pagehide while a request is in flight queues the flush behind it", async () => {
    const { useSettings, updateSettings, installFlushOnPagehide, DEFAULT_SETTINGS } = await load();
    const first = deferred<Settings>();
    updateSettings.mockReturnValueOnce(first.promise).mockResolvedValue(DEFAULT_SETTINGS);
    const uninstall = installFlushOnPagehide();
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    await vi.advanceTimersByTimeAsync(300);
    useSettings.getState().setPref({ layout: { sidebarWidth: 410 } });
    window.dispatchEvent(new Event("pagehide"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    first.resolve(DEFAULT_SETTINGS);
    await settle();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenLastCalledWith({ layout: { sidebarWidth: 410 } });
    uninstall();
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
