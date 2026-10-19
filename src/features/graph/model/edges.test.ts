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

// Coverage: every edge shape on non-zero dot lanes, in both curve directions.
describe("edgePath on higher lanes", () => {
  it("should ignore the dot's lane for a pass-through", () => {
    expect(edgePath({ top: 0, bottom: 0 }, 3)).toBe("M 7 0 V 28");
  });

  it("should draw a half line when a join's column is the dot's own on a higher lane", () => {
    expect(edgePath({ top: 2, bottom: null }, 2)).toBe("M 35 0 V 14");
  });

  it("should draw a half line when a fork's column is the dot's own on a higher lane", () => {
    expect(edgePath({ top: null, bottom: 2 }, 2)).toBe("M 35 14 V 28");
  });

  it("should curve a join leftwards into a dot on a lower lane", () => {
    expect(edgePath({ top: 3, bottom: null }, 1)).toBe("M 49 0 C 49 7 21 7 21 14");
  });

  it("should curve a join rightwards into a dot on a higher lane that is not zero", () => {
    expect(edgePath({ top: 1, bottom: null }, 3)).toBe("M 21 0 C 21 7 49 7 49 14");
  });

  it("should curve a fork rightwards out of a dot on a lane that is not zero", () => {
    expect(edgePath({ top: null, bottom: 3 }, 1)).toBe("M 21 14 C 21 21 49 21 49 28");
  });

  it("should curve a fork leftwards out of a dot on a higher lane that is not zero", () => {
    expect(edgePath({ top: null, bottom: 1 }, 3)).toBe("M 49 14 C 49 21 21 21 21 28");
  });
});

// Coverage: column 0 is falsy; it must not be mistaken for an absent end.
describe("edgePath column zero", () => {
  it("should treat top 0 with a null bottom as a join, not a fork", () => {
    expect(edgePath({ top: 0, bottom: null }, 1)).toBe("M 7 0 C 7 7 21 7 21 14");
  });

  it("should treat bottom 0 with a null top as a fork, not a join", () => {
    expect(edgePath({ top: null, bottom: 0 }, 1)).toBe("M 21 14 C 21 21 7 21 7 28");
  });
});

describe("laneColour boundaries", () => {
  it("should use token 7 for column 7", () => {
    expect(laneColour(7)).toBe("var(--graph-lane-7)");
  });

  it("should wrap column 16 back to token 0", () => {
    expect(laneColour(16)).toBe("var(--graph-lane-0)");
  });
});

describe("gutterWidth boundaries", () => {
  it("should be one lane wide for exactly one lane", () => {
    expect(gutterWidth(1)).toBe(14);
  });

  it("should still grow by one lane just below the cap", () => {
    expect(gutterWidth(11)).toBe(154);
  });

  it("should be one lane wide for a negative count", () => {
    expect(gutterWidth(-3)).toBe(14);
  });
});
