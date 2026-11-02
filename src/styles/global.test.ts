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
  // Longhands, not the `font` shorthand: the shorthand would also inherit the body's line-height.
  const controls = /button,\s*input,\s*select,\s*textarea\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  it("form controls inherit family, weight and style but keep the medium size", () => {
    expect(controls).toMatch(/font-family:\s*inherit;/);
    expect(controls).toMatch(/font-weight:\s*inherit;/);
    expect(controls).toMatch(/font-style:\s*inherit;/);
    expect(controls).toMatch(/font-size:\s*var\(--text-md\);/);
  });
  it("form controls do not use the font shorthand", () => {
    expect(controls).not.toMatch(/(^|[^-])font:/);
  });
  it("resets browser default font styles", () => {
    expect(css).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-size:\s*inherit;[^}]*font-weight:\s*700;/,
    );
    expect(css).toMatch(
      /code,\s*kbd,\s*pre,\s*samp\s*\{[^}]*font-family:\s*var\(--font-mono-ui\);[^}]*font-size:\s*inherit;/,
    );
    expect(css).toMatch(/strong,\s*b\s*\{[^}]*font-weight:\s*700;/);
  });
});

describe("control vocabulary", () => {
  it("styles opt-in buttons as pills of control height", () => {
    const b = block("button[data-variant]");
    expect(b).toMatch(/height:\s*var\(--control-h\)/);
    expect(b).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(b).toMatch(/padding:\s*0 14px/);
    expect(b).toMatch(/font-weight:\s*600/);
    expect(b).toMatch(/border:\s*0/);
  });
  it("fills primary with the accent and neutral with the 25% neutral", () => {
    expect(block('button[data-variant="primary"]')).toMatch(/background:\s*var\(--color-accent\)/);
    expect(block('button[data-variant="primary"]')).toMatch(/color:\s*var\(--color-on-accent\)/);
    expect(block('button[data-variant="neutral"]')).toMatch(
      /background:\s*rgba\(158, 158, 158, 0\.25\)/,
    );
    expect(block('button[data-variant="ghost"]')).toMatch(/background:\s*transparent/);
    expect(block('button[data-variant="danger"]')).toMatch(/color:\s*var\(--color-danger\)/);
  });
  it("makes icon buttons square and small buttons 24px", () => {
    expect(block('button[data-variant="icon"]')).toMatch(/width:\s*var\(--control-h\)/);
    expect(block('button[data-size="sm"]')).toMatch(/height:\s*var\(--control-h-sm\)/);
    expect(block('button[data-size="sm"]')).toMatch(/font-size:\s*var\(--text-xs\)/);
  });
  it("hovers neutral at 40% and ghost on the surface hover token", () => {
    expect(block('button[data-variant="neutral"]:hover:not(:disabled)')).toMatch(
      /background:\s*rgba\(158, 158, 158, 0\.4\)/,
    );
    expect(block('button[data-variant="ghost"]:hover:not(:disabled)')).toMatch(
      /background:\s*var\(--color-surface-hover\)/,
    );
  });
  it("dims disabled controls instead of recolouring them", () => {
    expect(block("button[data-variant]:disabled")).toMatch(/opacity:\s*0\.45/);
  });
  it("draws one focus ring for every control, on primary too", () => {
    const ring = block("button[data-variant]:focus-visible");
    expect(ring).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(ring).toMatch(/box-shadow:\s*0 0 0 4px var\(--color-accent-tint\)/);
    expect(css).toMatch(/input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible/);
  });
  it("styles text inputs on surface-2 with the border token", () => {
    const i = block('input:not([type="checkbox"]):not([type="radio"])');
    expect(i).toMatch(/background:\s*var\(--color-surface-2\)/);
    expect(i).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(i).toMatch(/height:\s*var\(--control-h\)/);
    expect(i).toMatch(/padding:\s*0 12px/);
    expect(i).toMatch(/border-radius:\s*var\(--radius-s\)/);
    expect(i).toMatch(/color:\s*var\(--color-text\)/);
    expect(block('input[type="search"]')).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });
  it("styles textareas with the same fill and border", () => {
    // Standalone rule, not the `button, input, select, textarea` font group.
    const t = /(?<!,\n)^textarea \{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(t).toMatch(/background:\s*var\(--color-surface-2\)/);
    expect(t).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(t).toMatch(/border-radius:\s*var\(--radius-s\)/);
  });
});
