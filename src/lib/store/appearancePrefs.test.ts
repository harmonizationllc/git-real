import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MONO,
  DIFF_FONT_DEFAULT,
  DIFF_FONT_MAX,
  DIFF_FONT_MIN,
  useAppearancePrefs,
} from "./appearancePrefs";

beforeEach(() => {
  localStorage.clear();
  useAppearancePrefs.setState(useAppearancePrefs.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Contract: defaults, persistence key/version, clamping, family trimming.
describe("useAppearancePrefs defaults", () => {
  it("defaults to system, null family and 13px", () => {
    expect(useAppearancePrefs.getInitialState()).toMatchObject({
      theme: "system",
      diffFontFamily: null,
      diffFontSize: DIFF_FONT_DEFAULT,
    });
  });

  it("exports DIFF_FONT_MIN=10, DIFF_FONT_MAX=24, DIFF_FONT_DEFAULT=13", () => {
    expect([DIFF_FONT_MIN, DIFF_FONT_MAX, DIFF_FONT_DEFAULT]).toEqual([10, 24, 13]);
  });

  it("exports DEFAULT_MONO as a non-empty string", () => {
    expect(typeof DEFAULT_MONO).toBe("string");
    expect(DEFAULT_MONO.length).toBeGreaterThan(0);
  });
});

// Contract: persists under git-real.appearancePrefs with version 1.
describe("useAppearancePrefs persistence", () => {
  it("persists under git-real.appearancePrefs with version 1", () => {
    useAppearancePrefs.getState().setTheme("dark");
    const raw = localStorage.getItem("git-real.appearancePrefs");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.version).toBe(1);
    expect(parsed.state).toMatchObject({ theme: "dark" });
  });

  it("persists only the three data fields, not the setters", () => {
    useAppearancePrefs.getState().setTheme("light");
    const raw = localStorage.getItem("git-real.appearancePrefs") as string;
    expect(Object.keys(JSON.parse(raw).state).sort()).toEqual([
      "diffFontFamily",
      "diffFontSize",
      "theme",
    ]);
  });
});

// Contract: setDiffFontSize clamps and rounds.
describe("useAppearancePrefs setDiffFontSize", () => {
  it("clamps 9 to 10", () => {
    useAppearancePrefs.getState().setDiffFontSize(9);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(10);
  });

  it("clamps 25 to 24", () => {
    useAppearancePrefs.getState().setDiffFontSize(25);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(24);
  });

  it("rounds 13.6 to 14", () => {
    useAppearancePrefs.getState().setDiffFontSize(13.6);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(14);
  });

  it("ignores NaN and stays at the previous value", () => {
    useAppearancePrefs.getState().setDiffFontSize(16);
    useAppearancePrefs.getState().setDiffFontSize(NaN);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(16);
  });

  it("accepts the exact minimum", () => {
    useAppearancePrefs.getState().setDiffFontSize(10);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(10);
  });

  it("accepts the exact maximum", () => {
    useAppearancePrefs.getState().setDiffFontSize(24);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(24);
  });
});

// Contract: setDiffFontFamily trims and maps blank to null.
describe("useAppearancePrefs setDiffFontFamily", () => {
  it('maps "" to null', () => {
    useAppearancePrefs.getState().setDiffFontFamily("");
    expect(useAppearancePrefs.getState().diffFontFamily).toBeNull();
  });

  it('maps "  " to null', () => {
    useAppearancePrefs.getState().setDiffFontFamily("  ");
    expect(useAppearancePrefs.getState().diffFontFamily).toBeNull();
  });

  it("trims whitespace from a non-blank value", () => {
    useAppearancePrefs.getState().setDiffFontFamily("  monospace  ");
    expect(useAppearancePrefs.getState().diffFontFamily).toBe("monospace");
  });

  it("stores null explicitly", () => {
    useAppearancePrefs.getState().setDiffFontFamily("mono");
    useAppearancePrefs.getState().setDiffFontFamily(null);
    expect(useAppearancePrefs.getState().diffFontFamily).toBeNull();
  });
});

// Contract: setTheme stores each value.
describe("useAppearancePrefs setTheme", () => {
  it.each(["system", "light", "dark"] as const)("stores theme %s", (theme) => {
    useAppearancePrefs.getState().setTheme(theme);
    expect(useAppearancePrefs.getState().theme).toBe(theme);
  });
});
