import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFontWarmupForTests, startFontWarmup, warmupOrder } from "./fontWarmup";
import type { FontCombo } from "./fontWarmup";

// Contract: warmupOrder lists every (family, size, weight) the stylesheets can produce, pane-first
// and de-duplicated by resolved value. startFontWarmup lays each cold combo out once, paced so a
// frame spends at most the budget (but always warms one), then removes its host and flags the root.

const SIZES: Record<string, string> = {
  "--text-xs": "11px",
  "--text-sm": "12px",
  "--text-md": "13px",
  "--text-base": "14px",
  "--text-lg": "16px",
  "--text-xl": "18px",
  "--text-2xl": "22px",
};
const ALL_SIZES = ["11px", "12px", "13px", "14px", "16px", "18px", "22px", "15px"];

/** A token reader over fixed values; `overrides` replaces any of them. */
function reader(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "--font-ui": "UISans",
    "--font-mono-ui": "UIMono",
    "--font-mono": "DiffMono",
    ...SIZES,
    "--diff-font-size": "15px",
    ...overrides,
  };
  return (name: string) => values[name] ?? "";
}

const combos = (family: string, sizes: string[], weight: string): FontCombo[] =>
  sizes.map((size) => ({ family, size, weight }));

let frames: (() => void)[] = [];
let clock = 0;
let costPerLayout = 25;
let warmed: FontCombo[] = [];
const root = document.documentElement;

/** Runs the callbacks queued for the next frame, then the macrotasks they scheduled. */
function frame() {
  const due = frames;
  frames = [];
  for (const cb of due) cb();
  vi.runOnlyPendingTimers();
}

function drain() {
  while (frames.length > 0) frame();
}

function start(read = reader()) {
  return startFontWarmup({
    root,
    readToken: read,
    requestFrame: (cb) => void frames.push(cb),
    now: () => clock,
  });
}

const host = () => document.querySelector("[data-font-warmup]");

beforeEach(() => {
  vi.useFakeTimers();
  resetFontWarmupForTests();
  frames = [];
  clock = 0;
  costPerLayout = 25;
  warmed = [];
  delete root.dataset.fontsWarm;
  // Each forced layout records the span's font and costs `costPerLayout` ms on the fake clock.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    warmed.push({
      family: this.style.fontFamily,
      size: this.style.fontSize,
      weight: this.style.fontWeight,
    });
    clock += costPerLayout;
    return 10;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  host()?.remove();
  delete root.dataset.fontsWarm;
});

describe("warmupOrder", () => {
  it("orders pane-first: ui normal, ui 600, mono-ui normal, mono-ui 600, 700s, then diff font", () => {
    expect(warmupOrder(reader())).toEqual([
      ...combos("UISans", ALL_SIZES, "normal"),
      ...combos("UISans", ALL_SIZES, "600"),
      ...combos("UIMono", ALL_SIZES, "normal"),
      ...combos("UIMono", ALL_SIZES, "600"),
      ...combos("UISans", ALL_SIZES, "700"),
      ...combos("UIMono", ALL_SIZES, "700"),
      ...combos("DiffMono", ALL_SIZES, "normal"),
      ...combos("DiffMono", ALL_SIZES, "600"),
      ...combos("DiffMono", ALL_SIZES, "700"),
    ]);
  });

  it("drops combos whose resolved values duplicate an earlier one (--font-mono equal to --font-mono-ui)", () => {
    const sizes = ALL_SIZES.slice(0, 7); // --diff-font-size 13px repeats --text-md
    expect(warmupOrder(reader({ "--font-mono": "UIMono", "--diff-font-size": "13px" }))).toEqual([
      ...combos("UISans", sizes, "normal"),
      ...combos("UISans", sizes, "600"),
      ...combos("UIMono", sizes, "normal"),
      ...combos("UIMono", sizes, "600"),
      ...combos("UISans", sizes, "700"),
      ...combos("UIMono", sizes, "700"),
    ]);
  });
});

describe("startFontWarmup", () => {
  it("warms at least one combo per frame and stops the batch once 40 ms are spent", () => {
    start();
    frame();
    expect(warmed).toEqual(warmupOrder(reader()).slice(0, 2));
    frame();
    expect(warmed).toEqual(warmupOrder(reader()).slice(0, 4));
  });

  it("a single lookup over budget ends the batch", () => {
    costPerLayout = 60;
    start();
    frame();
    expect(warmed).toHaveLength(1);
    frame();
    expect(warmed).toHaveLength(2);
  });

  it("starts only after a frame and a macrotask", () => {
    start();
    expect(warmed).toHaveLength(0);
    const due = frames;
    frames = [];
    for (const cb of due) cb();
    expect(warmed).toHaveLength(0);
    vi.runOnlyPendingTimers();
    expect(warmed).toHaveLength(2);
  });

  it("removes the host and sets data-fonts-warm when done", () => {
    start();
    frame();
    expect(host()).not.toBeNull();
    expect(host()?.getAttribute("aria-hidden")).toBe("true");
    expect(root.dataset.fontsWarm).toBeUndefined();
    drain();
    expect(warmed).toEqual(warmupOrder(reader()));
    expect(host()).toBeNull();
    expect(root.dataset.fontsWarm).toBe("true");
  });

  it("cancel removes the host and leaves data-fonts-warm unset", () => {
    const cancel = start();
    frame();
    expect(host()).not.toBeNull();
    cancel();
    expect(host()).toBeNull();
    const before = warmed.length;
    drain();
    vi.runAllTimers();
    expect(warmed).toHaveLength(before);
    expect(root.dataset.fontsWarm).toBeUndefined();
  });

  it("a second start warms only combos not yet warmed (new --diff-font-size)", () => {
    costPerLayout = 1;
    const shared = { "--font-mono": "UIMono", "--diff-font-size": "13px" };
    start(reader(shared));
    drain();
    expect(root.dataset.fontsWarm).toBe("true");
    warmed = [];
    start(reader({ ...shared, "--diff-font-size": "15px" }));
    drain();
    expect(warmed).toEqual([
      { family: "UISans", size: "15px", weight: "normal" },
      { family: "UISans", size: "15px", weight: "600" },
      { family: "UIMono", size: "15px", weight: "normal" },
      { family: "UIMono", size: "15px", weight: "600" },
      { family: "UISans", size: "15px", weight: "700" },
      { family: "UIMono", size: "15px", weight: "700" },
    ]);
  });

  it("a second start while running supersedes the first: each combo is warmed once", () => {
    costPerLayout = 60;
    start();
    frame();
    start();
    drain();
    expect(warmed).toEqual(warmupOrder(reader()));
    expect(host()).toBeNull();
    expect(root.dataset.fontsWarm).toBe("true");
  });
});
