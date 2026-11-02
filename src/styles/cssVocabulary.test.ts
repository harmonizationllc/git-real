import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const radiusValues = (css: string): string[] =>
  [
    ...strip(css).matchAll(
      /border-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius:\s*([^;}]+)|border-radius:\s*([^;}]+)/g,
    ),
  ].map((m) => (m[1] ?? m[2])!.trim());

const hasLiteralColour = (css: string): boolean =>
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(strip(css));

// A selection marker drawn as a side border or as an inset shadow strip, instead of the tint.
const hasBorderLeftMarker = (css: string): boolean =>
  /border-(?:left|inline-start)(-color)?:\s*(2px|3px)/.test(strip(css)) ||
  /box-shadow:\s*inset\s+2px\s+0\s+0\b/.test(strip(css));

const RADIUS_OK = /^(var\(--radius-(xs|s|m|pill)\)|50%|0)$/;

const modules = walk("src").filter((f) => f.endsWith(".module.css"));

describe("css vocabulary gate helpers", () => {
  it("flags literal colours but ignores comments", () => {
    expect(hasLiteralColour("a{color:#fff}")).toBe(true);
    expect(hasLiteralColour("a{color:rgba(0,0,0,.5)}")).toBe(true);
    expect(hasLiteralColour("/* #fff */ a{color:var(--color-text)}")).toBe(false);
  });

  it("flags bad radii and border-left markers", () => {
    const ok = (css: string) => radiusValues(css).every((v) => RADIUS_OK.test(v));
    expect(ok("a{border-radius: 4px}")).toBe(false);
    expect(ok("a{border-radius: var(--radius-s)}")).toBe(true);
    expect(hasBorderLeftMarker("a{border-left: 3px solid red}")).toBe(true);
    expect(hasBorderLeftMarker("a{border-left-color: 2px}")).toBe(true);
    expect(hasBorderLeftMarker("/* border-left: 3px */ a{}")).toBe(false);
  });

  it("flags longhand radii with non-token values", () => {
    const ok = (css: string) => radiusValues(css).every((v) => RADIUS_OK.test(v));
    expect(ok("a{border-top-left-radius: 4px}")).toBe(false);
    expect(ok("a{border-bottom-right-radius: 3px}")).toBe(false);
    expect(ok("a{border-start-start-radius: 4px}")).toBe(false);
    expect(ok("a{border-top-left-radius: 0}")).toBe(true);
    expect(ok("a{border-top-right-radius: var(--radius-s)}")).toBe(true);
    expect(ok("a{border-radius: var(--radius-s) 0 0 var(--radius-s)}")).toBe(false);
  });

  it("flags logical-property and inset-shadow selection markers", () => {
    expect(hasBorderLeftMarker("a{border-inline-start: 3px solid red}")).toBe(true);
    expect(hasBorderLeftMarker("a{border-inline-start-color: 2px}")).toBe(true);
    expect(hasBorderLeftMarker("a{box-shadow: inset 2px 0 0 var(--color-accent)}")).toBe(true);
    expect(hasBorderLeftMarker("a{box-shadow: var(--shadow-card)}")).toBe(false);
    expect(hasBorderLeftMarker("/* box-shadow: inset 2px 0 0 */ a{}")).toBe(false);
  });
});

describe("css vocabulary", () => {
  it("finds the module stylesheets", () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  it.each(modules)("%s has no literal colours", (f) => {
    expect(hasLiteralColour(readFileSync(f, "utf8"))).toBe(false);
  });

  it.each(modules)("%s uses radius tokens only", (f) => {
    for (const v of radiusValues(readFileSync(f, "utf8"))) expect(v).toMatch(RADIUS_OK);
  });

  it.each(modules)("%s never selects with border-left", (f) => {
    expect(hasBorderLeftMarker(readFileSync(f, "utf8"))).toBe(false);
  });
});
