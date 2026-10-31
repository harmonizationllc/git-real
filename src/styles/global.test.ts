import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// happy-dom applies no stylesheet and has no :focus-visible heuristic, so the CSS source is pinned.
const css = readFileSync("src/styles/global.css", "utf8");
const block = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";

// Contract: programmatic focus targets show no ring after a pointer action and the inset accent
// ring when the keyboard led there.
describe("global focus-target ring", () => {
  it("should remove the outline when a focus target is focused without focus-visible", () => {
    expect(block("[data-focus-target]:focus:not(:focus-visible)")).toMatch(/outline:\s*none/);
  });

  it("should draw the accent ring when a focus target is focus-visible", () => {
    expect(block("[data-focus-target]:focus-visible")).toContain(
      "outline: 2px solid var(--color-accent)",
    );
  });

  it("should inset the ring when a focus target is focus-visible", () => {
    expect(block("[data-focus-target]:focus-visible")).toContain("outline-offset: -2px");
  });

  it("should not style every tabindex=-1 element globally", () => {
    expect(css).not.toContain("[tabindex");
  });
});

describe("global font styles", () => {
  // The standalone body rule, not the `html,\nbody` group rule.
  const bodyBlock = /(?<!,\n)^body \{([^}]*)\}/m.exec(css)?.[1] ?? "";
  it("body uses the UI font token and the base size token", () => {
    expect(bodyBlock).toMatch(/font-family:\s*var\(--font-ui\);/);
    expect(bodyBlock).toMatch(/font-size:\s*var\(--text-base\);/);
  });
  it("form controls inherit the font family but keep the medium size", () => {
    expect(css).toMatch(
      /button,\s*input,\s*select,\s*textarea\s*\{[^}]*font:\s*inherit;[^}]*font-size:\s*var\(--text-md\);/,
    );
  });
  it("resets browser default font styles", () => {
    expect(css).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-size:\s*inherit;[^}]*font-weight:\s*inherit;/,
    );
    expect(css).toMatch(
      /code,\s*kbd,\s*pre,\s*samp\s*\{[^}]*font-family:\s*var\(--font-mono-ui\);[^}]*font-size:\s*var\(--text-sm\);/,
    );
    expect(css).toMatch(/strong,\s*b\s*\{[^}]*font-weight:\s*700;/);
  });
});
