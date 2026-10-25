// Task 14 (plan Step 3 / architect correction 1): fuzzyIndices powers the palette's <mark> runs.
import { describe, expect, it } from "vitest";
import { fuzzyIndices } from "./index";

describe("fuzzyIndices", () => {
  it("returns an empty array for an empty query", () => {
    expect(fuzzyIndices("", "anything")).toEqual([]);
  });

  it("returns the matched indices of a contiguous match", () => {
    expect(fuzzyIndices("fet", "Fetch")).toEqual([0, 1, 2]);
  });

  it("returns the leftmost index of each character for a scattered match", () => {
    expect(fuzzyIndices("pt", "palette")).toEqual([0, 4]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyIndices("PULL", "pull")).toEqual([0, 1, 2, 3]);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyIndices("xyz", "Fetch")).toBeNull();
  });

  it("returns null when a later character cannot be found in order", () => {
    expect(fuzzyIndices("ba", "abc")).toBeNull();
  });
});
