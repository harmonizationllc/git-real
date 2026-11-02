import { describe, expect, it } from "vitest";
import { mediaDarkBlock, parseBlock, selectorBlock } from "./tokenSource";

const lightMap = parseBlock(selectorBlock(":root {"));
const darkMap = parseBlock(mediaDarkBlock());

/** Resolve one level of var(--x) references against the same theme map. */
function resolveColor(map: Map<string, string>, name: string): string {
  let value = map.get(`--color-${name}`) ?? "";
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) value = map.get(ref[1]) ?? "";
  return value;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const PAIRS: [string, string][] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-2"],
  ["on-accent", "accent"],
  ["added", "surface"],
  ["modified", "surface"],
  ["removed", "surface"],
  ["danger", "surface"],
  ["warning", "surface"],
  ["accent", "surface"],
];

describe("token contrast", () => {
  it.each(PAIRS)("%s on %s meets 4.5:1 in light and dark", (fg, bg) => {
    expect(contrast(resolveColor(lightMap, fg), resolveColor(lightMap, bg))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(resolveColor(darkMap, fg), resolveColor(darkMap, bg))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
