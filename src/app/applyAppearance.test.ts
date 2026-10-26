import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract: applyAppearance sets or removes data-theme and the two CSS custom properties.
// bootstrapAppearance applies the injected settings before first render, follows the settings
// store, installs the flush hook and reconciles with the backend once.

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  syncWindowBackground: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  delete window.__GIT_REAL_SETTINGS__;
  // Reset html element attributes / style between tests.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--font-mono");
  document.documentElement.style.removeProperty("--diff-font-size");
});

const realMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = realMatchMedia;
  delete window.__GIT_REAL_SETTINGS__;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("applyAppearance theme attribute", () => {
  it("system removes data-theme", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    document.documentElement.setAttribute("data-theme", "dark");
    applyAppearance({ theme: "system", diffFontFamily: null, diffFontSize: 13 });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("light sets data-theme=light", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    applyAppearance({ theme: "light", diffFontFamily: null, diffFontSize: 13 });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("dark sets data-theme=dark", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    applyAppearance({ theme: "dark", diffFontFamily: null, diffFontSize: 13 });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("keeps a pre-applied data-theme equal to the stored theme without removing it", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    document.documentElement.setAttribute("data-theme", "dark");
    const remove = vi.spyOn(document.documentElement, "removeAttribute");
    applyAppearance({ theme: "dark", diffFontFamily: null, diffFontSize: 13 });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("applyAppearance font tokens", () => {
  it("sets --diff-font-size in px", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    applyAppearance({ theme: "system", diffFontFamily: null, diffFontSize: 16 });
    expect(document.documentElement.style.getPropertyValue("--diff-font-size")).toBe("16px");
  });

  it("sets --font-mono to the given family", async () => {
    const { applyAppearance } = await import("./applyAppearance");
    applyAppearance({ theme: "system", diffFontFamily: "monospace", diffFontSize: 13 });
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("monospace");
  });

  it("uses DEFAULT_MONO when the family is null", async () => {
    const { applyAppearance, DEFAULT_MONO } = await import("./applyAppearance");
    applyAppearance({ theme: "system", diffFontFamily: null, diffFontSize: 13 });
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(DEFAULT_MONO);
  });
});

/** Fresh copies of the store and the bootstrap, hydrated from the current injected global. */
async function load(reply?: { theme: "system" | "light" | "dark" }) {
  vi.resetModules();
  const { getSettings, updateSettings } = await import("../lib/ipc");
  const { DEFAULT_SETTINGS, useSettings } = await import("../lib/store/settings");
  vi.mocked(getSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...reply },
  });
  vi.mocked(updateSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const { bootstrapAppearance } = await import("./applyAppearance");
  return { getSettings, DEFAULT_SETTINGS, useSettings, bootstrapAppearance };
}

/**
 * Installs a fake `window.matchMedia` whose single query records `change` listeners.
 * `removeEventListener` really detaches, so `fire(matches)` reaches only listeners still attached.
 */
function fakeMatchMedia(initial = false) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === "change") listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === "change") listeners.delete(fn);
    }),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    mql,
    fire(matches: boolean) {
      mql.matches = matches;
      for (const fn of [...listeners]) fn();
    },
  };
}

describe("bootstrapAppearance", () => {
  it("applies the injected theme and fonts before the first render", async () => {
    const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
    window.__GIT_REAL_SETTINGS__ = {
      ...DEFAULT_SETTINGS,
      appearance: { theme: "dark", diffFontFamily: "Fira Code", diffFontSize: 17 },
    };
    const { bootstrapAppearance } = await load();
    bootstrapAppearance();
    // Synchronous: nothing has been awaited since the call.
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--font-mono")).toBe("Fira Code");
    expect(root.style.getPropertyValue("--diff-font-size")).toBe("17px");
  });

  it("re-applies when the settings store changes", async () => {
    const { bootstrapAppearance, useSettings } = await load();
    bootstrapAppearance();
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await useSettings.getState().flush();
  });

  it("leaves the page alone when another section changes", async () => {
    const { bootstrapAppearance, useSettings } = await load();
    bootstrapAppearance();
    document.documentElement.setAttribute("data-theme", "marker");
    useSettings.getState().setPref({ diff: { mode: "unified" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("marker");
    await useSettings.getState().flush();
  });

  it("calls reconcile exactly once and applies what the backend reports", async () => {
    const { bootstrapAppearance, getSettings } = await load({ theme: "light" });
    bootstrapAppearance();
    expect(getSettings).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("light"),
    );
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it("the uninstaller unsubscribes and removes both the pagehide and beforeunload listeners", async () => {
    const { bootstrapAppearance, useSettings } = await load();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const uninstall = bootstrapAppearance();
    const added = (type: string) => add.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn);
    expect(added("pagehide")).toHaveLength(1);
    expect(added("beforeunload")).toHaveLength(1);
    uninstall();
    expect(remove).toHaveBeenCalledWith("pagehide", added("pagehide")[0]);
    expect(remove).toHaveBeenCalledWith("beforeunload", added("beforeunload")[0]);
    // A change after uninstall is not applied to the page.
    document.documentElement.setAttribute("data-theme", "marker");
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("marker");
    await useSettings.getState().flush();
  });

  it("stops following the store and drops the flush hook once uninstalled", async () => {
    const { bootstrapAppearance, useSettings } = await load();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const uninstall = bootstrapAppearance();
    expect(add).toHaveBeenCalledWith("pagehide", expect.any(Function));
    uninstall();
    expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function));
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    expect(document.documentElement.getAttribute("data-theme")).not.toBe("dark");
    await useSettings.getState().flush();
  });

  it("syncs the window background when the desktop scheme changes while the theme is system", async () => {
    const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
    window.__GIT_REAL_SETTINGS__ = {
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: "system" },
    };
    const media = fakeMatchMedia();
    const { bootstrapAppearance } = await load();
    const { syncWindowBackground } = await import("../lib/ipc");
    bootstrapAppearance();
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    media.fire(true);
    expect(syncWindowBackground).toHaveBeenCalledTimes(1);
    expect(syncWindowBackground).toHaveBeenCalledWith(true);
  });

  it("ignores desktop scheme changes while the theme is explicit", async () => {
    const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
    window.__GIT_REAL_SETTINGS__ = {
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: "dark" },
    };
    const media = fakeMatchMedia();
    const { bootstrapAppearance } = await load({ theme: "dark" });
    const { syncWindowBackground } = await import("../lib/ipc");
    bootstrapAppearance();
    media.fire(true);
    expect(syncWindowBackground).not.toHaveBeenCalled();
  });

  it("syncs once when the theme switches to system", async () => {
    const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
    window.__GIT_REAL_SETTINGS__ = {
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: "dark" },
    };
    fakeMatchMedia(false);
    const { bootstrapAppearance, useSettings } = await load({ theme: "dark" });
    const { syncWindowBackground } = await import("../lib/ipc");
    bootstrapAppearance();
    useSettings.getState().setPref({ appearance: { theme: "system" } });
    expect(syncWindowBackground).toHaveBeenCalledTimes(1);
    expect(syncWindowBackground).toHaveBeenCalledWith(false);
    useSettings.getState().setPref({ appearance: { theme: "dark" } });
    expect(syncWindowBackground).toHaveBeenCalledTimes(1);
    await useSettings.getState().flush();
  });

  it("the uninstaller removes the media-query listener", async () => {
    const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
    window.__GIT_REAL_SETTINGS__ = {
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: "system" },
    };
    const media = fakeMatchMedia();
    const { bootstrapAppearance } = await load();
    const { syncWindowBackground } = await import("../lib/ipc");
    const uninstall = bootstrapAppearance();
    const added = media.mql.addEventListener.mock.calls.find(([type]) => type === "change")?.[1];
    expect(added).toEqual(expect.any(Function));
    uninstall();
    expect(media.mql.removeEventListener).toHaveBeenCalledWith("change", added);
    media.fire(true);
    expect(syncWindowBackground).not.toHaveBeenCalled();
  });
});
