import { describe, expect, it } from "vitest";
import { L } from "../../../test/diffFixtures";
import { pairLines } from "./pairing";

// Contract: deletions pair with the addition run that follows; context is two-sided.
describe("pairLines", () => {
  it("should make context lines two-sided with the same index", () => {
    expect(pairLines([L("context", "a"), L("context", "b")])).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: 1 },
    ]);
  });
  it("should zip a deletion run with the following addition run", () => {
    const lines = [L("deletion", "a"), L("deletion", "b"), L("addition", "A"), L("addition", "B")];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: 2 },
      { old: 1, new: 3 },
    ]);
  });
  it("should leave surplus deletions one-sided", () => {
    expect(pairLines([L("deletion", "a"), L("deletion", "b"), L("addition", "A")])).toEqual([
      { old: 0, new: 2 },
      { old: 1, new: null },
    ]);
  });
  it("should leave surplus additions one-sided", () => {
    expect(pairLines([L("deletion", "a"), L("addition", "A"), L("addition", "B")])).toEqual([
      { old: 0, new: 1 },
      { old: null, new: 2 },
    ]);
  });
  it("should leave an addition-only run one-sided", () => {
    expect(pairLines([L("addition", "A")])).toEqual([{ old: null, new: 0 }]);
  });
  it("should leave a deletion-only run one-sided", () => {
    expect(pairLines([L("deletion", "a")])).toEqual([{ old: 0, new: null }]);
  });
  it("should split runs at context and start a new run for a deletion after additions", () => {
    const lines = [
      L("deletion", "a"),
      L("addition", "A"),
      L("context", "c"),
      L("addition", "B"),
      L("deletion", "d"),
    ];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: 1 },
      { old: 2, new: 2 },
      { old: null, new: 3 },
      { old: 4, new: null },
    ]);
  });
  it("should yield no pairs for empty input", () => {
    expect(pairLines([])).toEqual([]);
  });
});

// Contract: an addition ends the deletion run, so a later deletion starts a new run that pairs afresh.
describe("pairLines interrupted runs", () => {
  it("should pair a second deletion/addition run independently of the first", () => {
    const lines = [L("deletion", "a"), L("addition", "A"), L("deletion", "b"), L("addition", "B")];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: 1 },
      { old: 2, new: 3 },
    ]);
  });
  it("should leave a trailing deletion after an addition one-sided", () => {
    expect(pairLines([L("addition", "A"), L("deletion", "b")])).toEqual([
      { old: null, new: 0 },
      { old: 1, new: null },
    ]);
  });
  it("should not pair deletions across a context line", () => {
    const lines = [L("deletion", "a"), L("context", "c"), L("addition", "A")];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: null },
      { old: 1, new: 1 },
      { old: null, new: 2 },
    ]);
  });
});
