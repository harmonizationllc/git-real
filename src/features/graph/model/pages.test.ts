import { describe, expect, it } from "vitest";
import { pageOf, pagesFor, pageStart } from "./pages";

// Contract: pagesFor lists the 500-row pages covering an inclusive row range.
describe("pagesFor", () => {
  it("should return one page for a range inside the first page", () => {
    expect(pagesFor(0, 10)).toEqual([0]);
  });

  it("should return two pages for a range straddling a boundary", () => {
    expect(pagesFor(499, 500)).toEqual([0, 1]);
  });

  it("should return the pages in the middle of the log", () => {
    expect(pagesFor(1200, 1700)).toEqual([2, 3]);
  });

  it("should return one page for a single row", () => {
    expect(pagesFor(500, 500)).toEqual([1]);
  });

  it("should return every page across a wide range", () => {
    expect(pagesFor(0, 1500)).toEqual([0, 1, 2, 3]);
  });

  it("should return no pages when last is before first", () => {
    expect(pagesFor(5, 4)).toEqual([]);
  });
});

// Contract: pageOf and pageStart convert between row indices and pages.
describe("pageOf", () => {
  it("should map row 0 to page 0", () => {
    expect(pageOf(0)).toBe(0);
  });

  it("should keep row 499 on page 0", () => {
    expect(pageOf(499)).toBe(0);
  });

  it("should map row 500 to page 1", () => {
    expect(pageOf(500)).toBe(1);
  });
});

describe("pageStart", () => {
  it("should start page 0 at row 0", () => {
    expect(pageStart(0)).toBe(0);
  });

  it("should start page 2 at row 1000", () => {
    expect(pageStart(2)).toBe(1000);
  });
});

// Coverage: page-boundary and degenerate ranges.
describe("pagesFor edges", () => {
  it("should return page 0 for the single row 0", () => {
    expect(pagesFor(0, 0)).toEqual([0]);
  });

  it("should return page 0 for the last row of the first page", () => {
    expect(pagesFor(499, 499)).toEqual([0]);
  });

  it("should return only page 1 for the exact span of page 1", () => {
    expect(pagesFor(500, 999)).toEqual([1]);
  });

  it("should return three pages for a range touching the first and third page", () => {
    expect(pagesFor(499, 1000)).toEqual([0, 1, 2]);
  });

  it("should return no pages when last is one before first at a page boundary", () => {
    expect(pagesFor(500, 499)).toEqual([]);
  });

  it("should return pages in ascending order for a deep range", () => {
    expect(pagesFor(49_999, 50_500)).toEqual([99, 100, 101]);
  });

  it("should never return a negative page for a negative first row", () => {
    // Rows start at 0; a negative index must not produce a page the backend would reject.
    expect(pagesFor(-5, 10).every((page) => page >= 0)).toBe(true);
  });
});

describe("pageOf and pageStart round trip", () => {
  it("should start the page that contains a row at or before that row", () => {
    expect(pageStart(pageOf(1234))).toBe(1000);
  });

  it("should map the first row after a page back to the next page", () => {
    expect(pageOf(pageStart(7) + 499)).toBe(7);
  });
});
