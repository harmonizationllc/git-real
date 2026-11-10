import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationsOf } from "../../../test/cssRules";
import { rowHeightEstimate } from "./rowHeight";

// Contract: a single-line row is the code's 1.4 line box at the diff font size, never shorter
// than the 18 px gutter.
describe("rowHeightEstimate", () => {
  it.each([
    [10, 18], // 14 px line box, but the 18 px gutter sets the row
    [13, 18], // the default: 18.2 → 18
    [14, 20], // 19.6 → 20
    [16, 22],
    [24, 34],
  ])("should give a %i px font a %i px row", (size, px) => {
    expect(rowHeightEstimate(size)).toBe(px);
  });
});

// Contract: the row estimate is exact only while these CSS values hold.
describe("rowHeightEstimate CSS", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("should keep the code and sign cells at line-height 1.4", () => {
    const lineCss = read("src/features/diff/LineContent.module.css");
    const rowCss = read("src/features/diff/DiffRows.module.css");
    expect(declarationsOf(lineCss, "code")).toMatch(/line-height:\s*1\.4;/);
    expect(declarationsOf(rowCss, "sign")).toMatch(/line-height:\s*1\.4;/);
  });

  it("should keep the gutter at 12 px with line-height 1.5", () => {
    const rowCss = read("src/features/diff/DiffRows.module.css");
    expect(declarationsOf(rowCss, "gutter")).toMatch(/font-size:\s*var\(--text-xs\);/);
    expect(declarationsOf(rowCss, "gutter")).toMatch(/line-height:\s*1\.5;/);
    const root = /:root\s*\{([^}]*)\}/.exec(read("src/styles/tokens.css"))?.[1] ?? "";
    expect(root).toMatch(/--text-xs:\s*12px;/);
  });
});
