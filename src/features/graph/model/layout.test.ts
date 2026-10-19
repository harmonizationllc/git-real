import { describe, expect, it } from "vitest";
import {
  LANE_WIDTH,
  MAX_DRAWN_LANES,
  MAX_LABELS,
  PAGE_SIZE,
  ROW_HEIGHT,
  SEARCH_DEBOUNCE_MS,
  shortOid,
} from "./layout";

// Contract: the graph's pinned layout constants.
describe("graph layout constants", () => {
  it("should page 500 rows at a time", () => {
    expect(PAGE_SIZE).toBe(500);
  });

  it("should draw rows 28px tall", () => {
    expect(ROW_HEIGHT).toBe(28);
  });

  it("should space lanes 14px apart", () => {
    expect(LANE_WIDTH).toBe(14);
  });

  it("should draw at most 12 lanes", () => {
    expect(MAX_DRAWN_LANES).toBe(12);
  });

  it("should show at most 3 ref labels per row", () => {
    expect(MAX_LABELS).toBe(3);
  });

  it("should debounce search by 200ms", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});

// Contract: shortOid abbreviates a full object id to its first seven characters.
describe("shortOid", () => {
  it("should keep the first seven characters of a full id", () => {
    expect(shortOid("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  });

  it("should return an id shorter than seven characters unchanged", () => {
    expect(shortOid("abc")).toBe("abc");
  });

  it("should return an empty string for an empty id", () => {
    expect(shortOid("")).toBe("");
  });
});
