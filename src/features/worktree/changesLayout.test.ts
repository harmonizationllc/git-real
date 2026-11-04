import { describe, expect, it } from "vitest";
import { fitChangesPanes } from "./changesLayout";

describe("fitChangesPanes", () => {
  it("splits the shared space in half when nothing is stored", () => {
    expect(fitChangesPanes(400, 0, null)).toEqual({
      conflicts: 0,
      unstaged: 200,
      staged: 200,
      max: 328,
    });
  });

  it("uses the stored height and gives Staged the rest", () => {
    expect(fitChangesPanes(400, 0, 300)).toEqual({
      conflicts: 0,
      unstaged: 300,
      staged: 100,
      max: 328,
    });
  });

  it("clamps a stored height to the floor and to the maximum", () => {
    expect(fitChangesPanes(400, 0, 10).unstaged).toBe(72);
    expect(fitChangesPanes(400, 0, 1000)).toEqual({
      conflicts: 0,
      unstaged: 328,
      staged: 72,
      max: 328,
    });
  });

  it("takes the Conflicts content height off the shared space", () => {
    expect(fitChangesPanes(400, 100, null)).toEqual({
      conflicts: 100,
      unstaged: 150,
      staged: 150,
      max: 228,
    });
  });

  it("caps Conflicts at 40 % of the container", () => {
    expect(fitChangesPanes(400, 300, null)).toEqual({
      conflicts: 160,
      unstaged: 120,
      staged: 120,
      max: 168,
    });
  });

  it("never drops a pane below its floor in a short container", () => {
    expect(fitChangesPanes(100, 0, null)).toEqual({
      conflicts: 0,
      unstaged: 72,
      staged: 72,
      max: 72,
    });
  });

  it("passes through an unmeasured container", () => {
    expect(fitChangesPanes(0, 50, 300)).toEqual({
      conflicts: 50,
      unstaged: 72,
      staged: 72,
      max: Infinity,
    });
  });
});
