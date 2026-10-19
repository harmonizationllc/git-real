import { describe, expect, it } from "vitest";
import { edgePath, gutterWidth, laneColour, laneX } from "./edges";

// Contract: laneX centres a column inside its 14px lane.
describe("laneX", () => {
  it("should centre column 0", () => {
    expect(laneX(0)).toBe(7);
  });

  it("should centre column 2", () => {
    expect(laneX(2)).toBe(35);
  });
});

// Contract: edgePath draws one row segment; the dot sits at y=14 of a 28px row.
describe("edgePath pass-through", () => {
  it("should draw a vertical line across the whole row", () => {
    expect(edgePath({ top: 1, bottom: 1 }, 0)).toBe("M 21 0 V 28");
  });

  it("should draw the vertical line at the edge's column, not the dot's", () => {
    expect(edgePath({ top: 3, bottom: 3 }, 0)).toBe("M 49 0 V 28");
  });
});

describe("edgePath join (ends at the dot)", () => {
  it("should draw a half line when the column is the dot's own", () => {
    expect(edgePath({ top: 0, bottom: null }, 0)).toBe("M 7 0 V 14");
  });

  it("should draw a curve when the column differs from the dot's", () => {
    expect(edgePath({ top: 1, bottom: null }, 0)).toBe("M 21 0 C 21 7 7 7 7 14");
  });

  it("should curve towards a dot on a higher column", () => {
    expect(edgePath({ top: 0, bottom: null }, 2)).toBe("M 7 0 C 7 7 35 7 35 14");
  });
});

describe("edgePath fork (starts at the dot)", () => {
  it("should draw a half line when the column is the dot's own", () => {
    expect(edgePath({ top: null, bottom: 0 }, 0)).toBe("M 7 14 V 28");
  });

  it("should draw a curve when the column differs from the dot's", () => {
    expect(edgePath({ top: null, bottom: 2 }, 0)).toBe("M 7 14 C 7 21 35 21 35 28");
  });

  it("should curve from a dot on a higher column", () => {
    expect(edgePath({ top: null, bottom: 0 }, 2)).toBe("M 35 14 C 35 21 7 21 7 28");
  });
});

// Contract: lane colours cycle through eight design tokens.
describe("laneColour", () => {
  it("should use the column's own token below eight", () => {
    expect(laneColour(3)).toBe("var(--graph-lane-3)");
  });

  it("should wrap column 8 back to token 0", () => {
    expect(laneColour(8)).toBe("var(--graph-lane-0)");
  });

  it("should colour column 9 by column modulo 8", () => {
    expect(laneColour(9)).toBe("var(--graph-lane-1)");
  });
});

// Contract: the gutter is at least one lane and at most MAX_DRAWN_LANES wide.
describe("gutterWidth", () => {
  it("should be one lane wide when there are no lanes", () => {
    expect(gutterWidth(0)).toBe(14);
  });

  it("should be one lane per column below the cap", () => {
    expect(gutterWidth(5)).toBe(70);
  });

  it("should be exactly the cap at the cap", () => {
    expect(gutterWidth(12)).toBe(168);
  });

  it("should stop growing past the cap", () => {
    expect(gutterWidth(40)).toBe(168);
  });
});
