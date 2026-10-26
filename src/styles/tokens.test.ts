import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read tokens.css relative to this file.
const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

/**
 * Parse a CSS block into a map of property → value.
 * Strips comments and matches `{ decls }` blocks (ignoring @media wrappers).
 */
function parseBlock(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/**
 * Extract the declarations from one selector block identified by a string prefix.
 * E.g. selectorBlock(":root {") returns everything inside that first :root block.
 */
function selectorBlock(selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return "";
  const start = css.indexOf("{", idx);
  let depth = 1;
  let i = start + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(start + 1, i - 1);
}

// The bare :root block (light values).
const rootBlock = selectorBlock(":root {");
const rootMap = parseBlock(rootBlock);

// The media-dark block: @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }
const mediaDarkBlock = (() => {
  const mediaIdx = css.indexOf("@media (prefers-color-scheme: dark)");
  if (mediaIdx === -1) return "";
  // Find the first nested { … } inside the media block that belongs to the selector.
  const mediaOpen = css.indexOf("{", mediaIdx);
  const selectorOpen = css.indexOf("{", mediaOpen + 1);
  let depth = 1;
  let i = selectorOpen + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(selectorOpen + 1, i - 1);
})();
const mediaDarkMap = parseBlock(mediaDarkBlock);

// The attribute-dark block: :root[data-theme="dark"] { … }
const attrDarkBlock = selectorBlock(':root[data-theme="dark"] {');
const attrDarkMap = parseBlock(attrDarkBlock);

// Theme tokens are --color-*, --syntax-* and --graph-lane-* only.
function themeTokens(m: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of m) {
    if (/^--(color|syntax|graph-lane)-/.test(k)) out.set(k, v);
  }
  return out;
}

const lightTheme = themeTokens(rootMap);
const mediaDarkTheme = themeTokens(mediaDarkMap);
// Review Focus item 3 (plan § Task 7): token structure assertions.
describe("tokens.css structure", () => {
  it("declares 38 theme tokens on :root plus --font-mono and --diff-font-size", () => {
    expect(lightTheme.size).toBe(38);
    expect(rootMap.has("--font-mono")).toBe(true);
    expect(rootMap.has("--diff-font-size")).toBe(true);
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
