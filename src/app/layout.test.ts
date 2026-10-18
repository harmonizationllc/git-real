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
import * as storeDefaults from "../lib/store/layoutPrefs";

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

// Contract: the defaults live in the store and are re-exported here.
describe("layout default re-exports", () => {
  it("should re-export the store's defaults", () => {
    expect([REFS_DEFAULT, SIDEBAR_DEFAULT]).toEqual([
      storeDefaults.REFS_DEFAULT,
      storeDefaults.SIDEBAR_DEFAULT,
    ]);
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

// Coverage audit: boundary and degenerate containers.
describe("clampWidths boundaries", () => {
  const fit = REFS_MIN + SIDEBAR_MIN + DETAIL_MIN;

  it("keeps the minimums untouched when the container exactly equals the sum of minimums", () =>
    expect(clampWidths(fit, REFS_MIN, SIDEBAR_MIN)).toEqual({ refs: 160, sidebar: 240 }));

  it("shrinks the sidebar by exactly the overflow when the container is one pixel too small", () =>
    expect(clampWidths(879, 240, 320)).toEqual({ refs: 240, sidebar: 319 }));

  it("cuts the refs column only once the sidebar is exhausted, one pixel at a time", () =>
    expect(clampWidths(759, 240, 320)).toEqual({ refs: 199, sidebar: 240 }));

  it("lands exactly on the minimums when the overflow equals the available slack", () =>
    expect(clampWidths(fit, 240, 320)).toEqual({ refs: 160, sidebar: 240 }));

  it("treats a negative container as unmeasured and passes widths through", () =>
    expect(clampWidths(-5, 10, 10)).toEqual({ refs: 10, sidebar: 10 }));

  it("handles fractional widths without rounding", () =>
    expect(clampWidths(879.5, 240.25, 320.5)).toEqual({ refs: 240.25, sidebar: 319.25 }));

  it("returns the sum of both columns plus the detail minimum within the container whenever possible", () => {
    const { refs, sidebar } = clampWidths(1000, 400, 500);
    expect(refs + sidebar + DETAIL_MIN).toBe(1000);
  });
});

describe("maxWidth boundaries", () => {
  it("is unbounded for a negative container", () =>
    expect(maxWidth(-1, "sidebar", 240)).toBe(Infinity));

  it("equals the column minimum exactly when the container is the sum of minimums", () => {
    const fit = REFS_MIN + SIDEBAR_MIN + DETAIL_MIN;
    expect(maxWidth(fit, "refs", SIDEBAR_MIN)).toBe(REFS_MIN);
    expect(maxWidth(fit, "sidebar", REFS_MIN)).toBe(SIDEBAR_MIN);
  });

  it("grows by one pixel when the container grows by one pixel past the minimums", () =>
    expect(maxWidth(721, "refs", SIDEBAR_MIN)).toBe(161));

  it("treats a below-minimum sidebar as its minimum when computing the refs maximum", () =>
    expect(maxWidth(1000, "refs", 0)).toBe(1000 - DETAIL_MIN - SIDEBAR_MIN));

  it("treats a below-minimum refs column as its minimum when computing the sidebar maximum", () =>
    expect(maxWidth(1000, "sidebar", 0)).toBe(1000 - DETAIL_MIN - REFS_MIN));
});
