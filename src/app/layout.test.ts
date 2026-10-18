import { describe, expect, it } from "vitest";
import {
  DETAIL_MIN,
  KEY_STEP,
  REFS_DEFAULT,
  REFS_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  clampWidths,
  maxWidth,
} from "./layout";

// Contract: the layout constants are pinned by the spec.
describe("layout constants", () => {
  it("should pin the minimums, defaults and key step", () => {
    expect({ REFS_MIN, SIDEBAR_MIN, DETAIL_MIN, REFS_DEFAULT, SIDEBAR_DEFAULT, KEY_STEP }).toEqual({
      REFS_MIN: 160,
      SIDEBAR_MIN: 240,
      DETAIL_MIN: 320,
      REFS_DEFAULT: 240,
      SIDEBAR_DEFAULT: 320,
      KEY_STEP: 16,
    });
  });
});

// Contract: clampWidths shrinks the sidebar first, then the refs column, never below minimums.
describe("clampWidths", () => {
  it("passes widths through when the container is unmeasured", () =>
    expect(clampWidths(0, 240, 320)).toEqual({ refs: 240, sidebar: 320 }));

  it("keeps widths that fit", () =>
    expect(clampWidths(1200, 240, 320)).toEqual({ refs: 240, sidebar: 320 }));

  it("shrinks the sidebar before the refs column", () =>
    expect(clampWidths(860, 240, 320)).toEqual({ refs: 240, sidebar: 300 }));

  it("shrinks the refs column once the sidebar is at its minimum", () =>
    expect(clampWidths(760, 240, 320)).toEqual({ refs: 200, sidebar: 240 }));

  it("never goes below the minimums", () =>
    expect(clampWidths(100, 240, 320)).toEqual({ refs: 160, sidebar: 240 }));

  it("raises widths below the minimums", () =>
    expect(clampWidths(1200, 10, 10)).toEqual({ refs: 160, sidebar: 240 }));

  it("keeps widths that exactly fill the container", () =>
    expect(clampWidths(880, 240, 320)).toEqual({ refs: 240, sidebar: 320 }));
});

// Contract: maxWidth is the largest width one column may take while the others keep minimums.
describe("maxWidth", () => {
  it("leaves room for the other column and the detail minimum", () => {
    expect(maxWidth(1200, "refs", 320)).toBe(560);
    expect(maxWidth(1200, "sidebar", 240)).toBe(640);
  });

  it("is never below the column minimum", () => {
    expect(maxWidth(300, "refs", 320)).toBe(160);
    expect(maxWidth(300, "sidebar", 240)).toBe(240);
  });

  it("is unbounded when unmeasured", () => expect(maxWidth(0, "refs", 320)).toBe(Infinity));

  it("treats a below-minimum other column as its minimum", () =>
    expect(maxWidth(1200, "refs", 10)).toBe(1200 - DETAIL_MIN - SIDEBAR_MIN));
});
