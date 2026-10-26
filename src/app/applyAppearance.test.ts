import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract: applyAppearance sets or removes data-theme and the two CSS custom properties.
// bootstrapAppearance applies the injected settings before first render, follows the settings
// store, installs the flush hook and reconciles with the backend once.

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  delete window.__GIT_REAL_SETTINGS__;
  // Reset html element attributes / style between tests.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--font-mono");
  document.documentElement.style.removeProperty("--diff-font-size");
});

afterEach(() => {
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
});
