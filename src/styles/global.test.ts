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
