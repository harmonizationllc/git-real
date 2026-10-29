import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsPatch } from "../lib/ipc";

// Contract: bootstrapShortcuts pushes the resolved bindings into the module state now and whenever
// the store's shortcuts section changes, and stops following once uninstalled.

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  delete window.__GIT_REAL_SETTINGS__;
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__GIT_REAL_SETTINGS__;
  vi.restoreAllMocks();
  vi.resetModules();
});

/** A fresh module graph hydrated from injected settings carrying `bindings`, with an echoing backend. */
async function load(bindings: Settings["shortcuts"]["bindings"]) {
  const { DEFAULT_SETTINGS } = await import("../lib/store/settings");
  let server: Settings = { ...DEFAULT_SETTINGS, shortcuts: { bindings } };
  window.__GIT_REAL_SETTINGS__ = server;
  vi.resetModules();
  const ipc = await import("../lib/ipc");
  vi.mocked(ipc.updateSettings).mockImplementation(async (patch: SettingsPatch) => {
    server = { ...server, ...(patch as Partial<Settings>) };
    return server;
  });
  return {
    ...(await import("./bootstrapShortcuts")),
    ...(await import("../lib/shortcuts")),
    ...(await import("../lib/store/settingsActions")),
  };
}

describe("bootstrapShortcuts", () => {
  it("applies the injected bindings at once", async () => {
    const { bootstrapShortcuts, activeKeys } = await load({ fetch: "Mod+Alt+F" });
    bootstrapShortcuts();
    expect(activeKeys("fetch")).toBe("Mod+Alt+F");
  });

  it("follows later changes until uninstalled", async () => {
    const { bootstrapShortcuts, activeKeys, setShortcutBindings } = await load({
      fetch: "Mod+Alt+F",
    });
    const uninstall = bootstrapShortcuts();
    setShortcutBindings({ fetch: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(activeKeys("fetch")).toBeNull();

    uninstall();
    setShortcutBindings({ fetch: "Mod+Alt+G" });
    await vi.advanceTimersByTimeAsync(300);
    expect(activeKeys("fetch")).toBeNull();
  });

  it("ignores changes to other sections", async () => {
    const { bootstrapShortcuts, activeKeys, setActiveBindings, resolveBindings, setTheme } =
      await load({});
    bootstrapShortcuts();
    // A sentinel the subscription would overwrite if it reacted to an unrelated section.
    setActiveBindings(resolveBindings({ fetch: "Mod+Alt+Z" }));
    setTheme("dark");
    await vi.advanceTimersByTimeAsync(300);
    expect(activeKeys("fetch")).toBe("Mod+Alt+Z");
  });
});
