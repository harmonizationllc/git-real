import { describe, expect, it } from "vitest";
import { TEXT_SIZE_TOKENS } from "./fontTokens";
import {
  css,
  mediaDarkBlock as readMediaDarkBlock,
  parseBlock,
  selectorBlock,
} from "./tokenSource";

// The bare :root block (light values).
const rootBlock = selectorBlock(":root {");
const rootMap = parseBlock(rootBlock);

// The media-dark block: @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }
const mediaDarkBlock = readMediaDarkBlock();
const mediaDarkMap = parseBlock(mediaDarkBlock);

// The attribute-dark block: :root[data-theme="dark"] { … }
const attrDarkBlock = selectorBlock(':root[data-theme="dark"] {');
const attrDarkMap = parseBlock(attrDarkBlock);

// Theme tokens are --color-*, --syntax-*, --graph-lane-* and --shadow-*; fonts, type scale,
// spacing, radius and control sizes are theme-independent.
function themeTokens(m: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of m) {
    if (/^--(color|syntax|graph-lane|shadow)-/.test(k)) out.set(k, v);
  }
  return out;
}

const lightTheme = themeTokens(rootMap);
const mediaDarkTheme = themeTokens(mediaDarkMap);
// Review Focus item 3 (plan § Task 7): token structure assertions.
describe("tokens.css structure", () => {
  it("declares 42 theme tokens on :root plus --font-mono and --diff-font-size", () => {
    expect(lightTheme.size).toBe(42); // 38 + surface-2, accent-tint, shadow-card, backdrop
    expect(rootMap.has("--font-mono")).toBe(true);
    expect(rootMap.has("--diff-font-size")).toBe(true);
  });

  it("uses the COSMIC light palette on :root", () => {
    expect(rootMap.get("--color-bg")).toBe("#d7d7d7");
    expect(rootMap.get("--color-surface")).toBe("#ffffff");
    expect(rootMap.get("--color-surface-2")).toBe("#f0f0f0");
    expect(rootMap.get("--color-text")).toBe("#161616");
    expect(rootMap.get("--color-text-muted")).toBe("#555555");
    expect(rootMap.get("--color-accent")).toBe("#00525a");
    expect(rootMap.get("--color-on-accent")).toBe("#ffffff");
    expect(rootMap.get("--color-accent-tint")).toBe("rgba(0, 82, 90, 0.12)");
    expect(rootMap.get("--color-danger")).toBe("#890418");
    expect(rootMap.get("--color-warning")).toBe("#792c00");
    expect(rootMap.get("--color-added")).toBe("#00572c");
    expect(rootMap.get("--color-modified")).toBe("#624000");
    expect(rootMap.get("--color-removed")).toBe("#890418");
    expect(rootMap.get("--graph-lane-0")).toBe("var(--color-accent)");
    expect(rootMap.get("--shadow-card")).toBe("0 0 0 1px rgba(0, 0, 0, 0.08)");
    expect(rootMap.get("--color-backdrop")).toBe("rgba(0, 0, 0, 0.4)");
  });

  it("uses the COSMIC dark palette in both dark blocks", () => {
    for (const map of [mediaDarkMap, attrDarkMap]) {
      expect(map.get("--color-bg")).toBe("#1b1b1b");
      expect(map.get("--color-surface")).toBe("#262626");
      expect(map.get("--color-surface-2")).toBe("#303030");
      expect(map.get("--color-text")).toBe("#f2f2f2");
      expect(map.get("--color-text-muted")).toBe("#b4b4b4");
      expect(map.get("--color-accent")).toBe("#63d0df");
      expect(map.get("--color-on-accent")).toBe("#111111");
      expect(map.get("--color-accent-tint")).toBe("rgba(99, 208, 223, 0.16)");
      expect(map.get("--color-added")).toBe("#5edb8c");
      expect(map.get("--color-modified")).toBe("#ffad00");
      expect(map.get("--color-removed")).toBe("#ffa09a");
      expect(map.get("--shadow-card")).toBe("0 0 0 1px rgba(255, 255, 255, 0.08)");
      expect(map.get("--color-backdrop")).toBe("rgba(0, 0, 0, 0.4)");
    }
  });

  it("pins the rest of the spec table in light and dark", () => {
    const light: Record<string, string> = {
      "--color-surface-hover": "rgba(46, 46, 46, 0.08)",
      "--color-border": "rgba(0, 0, 0, 0.08)",
      "--color-added-bg": "rgba(0, 87, 44, 0.1)",
      "--color-removed-bg": "rgba(137, 4, 24, 0.1)",
      "--color-added-word-bg": "rgba(0, 87, 44, 0.24)",
      "--color-removed-word-bg": "rgba(137, 4, 24, 0.22)",
      "--color-hunk-bg": "rgba(0, 82, 90, 0.08)",
      "--color-line-selected": "rgba(98, 64, 0, 0.14)",
      "--graph-lane-1": "#185529",
      "--graph-lane-2": "#624000",
      "--graph-lane-3": "#78292e",
      "--graph-lane-4": "#68217c",
      "--graph-lane-5": "#2e496d",
      "--graph-lane-6": "#86043a",
      "--graph-lane-7": "#554742",
      "--syntax-keyword": "#86043a",
      "--syntax-string": "#185529",
      "--syntax-number": "#2e496d",
      "--syntax-comment": "#636363",
      "--syntax-variable": "#624000",
      "--syntax-type": "#68217c",
      "--syntax-function": "#68217c",
      "--syntax-operator": "#00525a",
      "--syntax-punctuation": "#2e2e2e",
      "--syntax-meta": "#00572c",
      "--syntax-invalid": "#890418",
    };
    const dark: Record<string, string> = {
      "--color-surface-hover": "rgba(158, 158, 158, 0.1)",
      "--color-border": "rgba(255, 255, 255, 0.08)",
      "--color-danger": "#ffa09a",
      "--color-warning": "#ffad00",
      "--color-added-bg": "rgba(94, 219, 140, 0.12)",
      "--color-removed-bg": "rgba(255, 160, 154, 0.14)",
      "--color-added-word-bg": "rgba(94, 219, 140, 0.32)",
      "--color-removed-word-bg": "rgba(255, 160, 154, 0.36)",
      "--color-hunk-bg": "rgba(99, 208, 223, 0.1)",
      "--color-line-selected": "rgba(255, 173, 0, 0.18)",
      "--graph-lane-0": "var(--color-accent)",
      "--graph-lane-1": "#5edb8c",
      "--graph-lane-2": "#ffad00",
      "--graph-lane-3": "#ffa09a",
      "--graph-lane-4": "#e79cfe",
      "--graph-lane-5": "#a1c0eb",
      "--graph-lane-6": "#ff9cb1",
      "--graph-lane-7": "#cabab4",
      "--syntax-keyword": "#ff9cb1",
      "--syntax-string": "#92cf9c",
      "--syntax-number": "#a1c0eb",
      "--syntax-comment": "#9e9e9e",
      "--syntax-variable": "#ffad00",
      "--syntax-type": "#e79cfe",
      "--syntax-function": "#e79cfe",
      "--syntax-operator": "#63d0df",
      "--syntax-punctuation": "#dedede",
      "--syntax-meta": "#5edb8c",
      "--syntax-invalid": "#ffa09a",
    };
    for (const [k, v] of Object.entries(light)) expect([k, rootMap.get(k)]).toEqual([k, v]);
    for (const [k, v] of Object.entries(dark)) {
      expect([k, mediaDarkMap.get(k)]).toEqual([k, v]);
      expect([k, attrDarkMap.get(k)]).toEqual([k, v]);
    }
  });

  it("retires the GitHub palette", () => {
    expect(css).not.toMatch(/#396cd8|#f6f6f6|#cf222e|#1a7f37|#9a6700/i);
  });

  it("declares theme-independent spacing, radius and control tokens once on :root", () => {
    expect(rootMap.get("--space-1")).toBe("4px");
    expect(rootMap.get("--space-2")).toBe("8px");
    expect(rootMap.get("--space-3")).toBe("12px");
    expect(rootMap.get("--space-4")).toBe("16px");
    expect(rootMap.get("--space-5")).toBe("24px");
    expect(rootMap.get("--space-6")).toBe("32px");
    expect(rootMap.get("--radius-xs")).toBe("4px");
    expect(rootMap.get("--radius-s")).toBe("8px");
    expect(rootMap.get("--radius-m")).toBe("16px");
    expect(rootMap.get("--radius-pill")).toBe("999px");
    expect(rootMap.get("--control-h")).toBe("32px");
    expect(rootMap.get("--control-h-sm")).toBe("24px");
    for (const k of ["--space-2", "--radius-s", "--control-h"]) {
      expect(mediaDarkMap.has(k)).toBe(false);
      expect(attrDarkMap.has(k)).toBe(false);
    }
  });

  it(":root declares color-scheme light", () => {
    expect(rootBlock).toMatch(/color-scheme\s*:\s*light/);
  });

  // Review Focus item 3: the media dark block must be gated by :not([data-theme="light"]).
  it('the media dark block is gated by :not([data-theme="light"])', () => {
    expect(css).toMatch(
      /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)[^{]*\{[^{]*:root:not\(\[data-theme="light"\]\)/,
    );
  });

  // Review Focus item 3: the two dark blocks declare identical property/value pairs.
  it("the two dark blocks declare identical pairs", () => {
    expect(mediaDarkMap.size).toBeGreaterThan(0);
    expect(attrDarkMap.size).toBeGreaterThan(0);
    expect(mediaDarkMap).toEqual(attrDarkMap);
  });

  it("every light theme token has a dark counterpart", () => {
    for (const key of lightTheme.keys()) {
      expect(mediaDarkTheme.has(key)).toBe(true);
    }
  });

  it("the media dark block declares color-scheme dark", () => {
    expect(mediaDarkBlock).toMatch(/color-scheme\s*:\s*dark/);
  });

  it("the attribute dark block declares color-scheme dark", () => {
    expect(attrDarkBlock).toMatch(/color-scheme\s*:\s*dark/);
  });
});

describe("font tokens", () => {
  const root = rootMap;
  it("defines the family tokens on :root", () => {
    expect(root.get("--font-ui")).toBe("system-ui, sans-serif");
    expect(root.get("--font-mono-ui")).toBe("monospace, monospace");
    expect(root.get("--font-mono")).toBe("var(--font-mono-ui)");
  });
  it("selects the mono UI family per platform", () => {
    expect(parseBlock(selectorBlock(':root[data-platform="linux"] {')).get("--font-mono-ui")).toBe(
      "monospace, monospace",
    );
    expect(parseBlock(selectorBlock(':root[data-platform="macos"] {')).get("--font-mono-ui")).toBe(
      "ui-monospace, monospace",
    );
    expect(
      parseBlock(selectorBlock(':root[data-platform="windows"] {')).get("--font-mono-ui"),
    ).toBe("Consolas, monospace");
  });
  it("defines the px size scale", () => {
    expect(TEXT_SIZE_TOKENS.map((t) => root.get(t))).toEqual([
      "12px",
      "13px",
      "14px",
      "16px",
      "18px",
      "20px",
      "24px",
    ]);
  });
});
