import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract: applyAppearance sets or removes data-theme and the two CSS custom properties.
// bootstrapAppearance runs before first render and subscribes for later changes.

beforeEach(() => {
  localStorage.clear();
  // Reset html element attributes / style between tests.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--font-mono");
  document.documentElement.style.removeProperty("--diff-font-size");
});

afterEach(() => {
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

// Review Focus item 3: bootstrapAppearance must apply the stored theme BEFORE first render.
describe("bootstrapAppearance", () => {
  it("applies the stored theme before the first render", async () => {
    // Seed localStorage with a light theme before any module loads.
    localStorage.setItem(
      "git-real.appearancePrefs",
      JSON.stringify({
        state: { theme: "light", diffFontFamily: null, diffFontSize: 13 },
        version: 1,
      }),
    );
    // Re-import fresh modules so the persist store picks up the seeded value.
    vi.resetModules();
    const { bootstrapAppearance } = await import("./applyAppearance");
    bootstrapAppearance();
    // Must be synchronous: data-theme is set before the assertion.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("re-applies when the store changes", async () => {
    vi.resetModules();
    const { bootstrapAppearance } = await import("./applyAppearance");
    const { useAppearancePrefs } = await import("../lib/store/appearancePrefs");
    bootstrapAppearance();
    useAppearancePrefs.getState().setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stops re-applying after unsubscribe is called", async () => {
    vi.resetModules();
    const { bootstrapAppearance } = await import("./applyAppearance");
    const { useAppearancePrefs } = await import("../lib/store/appearancePrefs");
    const unsub = bootstrapAppearance();
    unsub();
    useAppearancePrefs.getState().setTheme("dark");
    // data-theme should not have been set to dark after unsubscribe.
    expect(document.documentElement.getAttribute("data-theme")).not.toBe("dark");
  });
});
