import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../lib/ipc";
import { makeRow } from "../../test/graphFixtures";
import { edgePath, gutterWidth, laneColour, laneX } from "./model/edges";
import { ROW_HEIGHT } from "./model/layout";
import { LaneGraph } from "./LaneGraph";

const pass: GraphEdge = { top: 0, bottom: 0 };
const join: GraphEdge = { top: 2, bottom: null };
const fork: GraphEdge = { top: null, bottom: 0 };

function draw(lane: number, edges: GraphEdge[], maxLanes = 3) {
  const { container } = render(<LaneGraph row={makeRow(0, { lane, edges })} maxLanes={maxLanes} />);
  return container;
}

const svg = (c: HTMLElement) => c.querySelector("svg") as SVGSVGElement;
const paths = (c: HTMLElement) => Array.from(c.querySelectorAll("path"));
const dot = (c: HTMLElement) => c.querySelector("circle") as SVGCircleElement;

// Contract: one path per edge, drawn with the model's geometry.
describe("LaneGraph edges", () => {
  it("should render one path per edge", () => {
    expect(paths(draw(1, [pass, join, fork]))).toHaveLength(3);
  });

  it("should render no path for a row without edges", () => {
    expect(paths(draw(0, []))).toHaveLength(0);
  });

  it("should draw each path with the edgePath geometry for the row's lane", () => {
    const d = paths(draw(1, [pass, join, fork])).map((p) => p.getAttribute("d"));
    expect(d).toEqual([pass, join, fork].map((e) => edgePath(e, 1)));
  });
});

// Contract: stroke colour follows the top column for pass-through and join, the bottom for fork.
describe("LaneGraph colours", () => {
  it("should stroke a pass-through in the colour of its column", () => {
    const [p] = paths(draw(1, [{ top: 3, bottom: 3 }]));
    expect(p?.getAttribute("stroke")).toBe(laneColour(3));
  });

  it("should stroke a join in the colour of its top column", () => {
    const [p] = paths(draw(0, [join]));
    expect(p?.getAttribute("stroke")).toBe(laneColour(2));
  });

  it("should stroke a fork in the colour of its bottom column", () => {
    const [p] = paths(draw(1, [{ top: null, bottom: 4 }]));
    expect(p?.getAttribute("stroke")).toBe(laneColour(4));
  });

  it("should cycle the colour token modulo eight", () => {
    const [p] = paths(draw(0, [{ top: 9, bottom: 9 }], 10));
    expect(p?.getAttribute("stroke")).toBe("var(--graph-lane-1)");
  });
});

// Contract: the commit dot sits in the row's lane at mid-height in the lane colour.
describe("LaneGraph dot", () => {
  it("should render exactly one dot", () => {
    expect(draw(0, [pass]).querySelectorAll("circle")).toHaveLength(1);
  });

  it("should centre the dot horizontally on the row's lane", () => {
    expect(dot(draw(2, [])).getAttribute("cx")).toBe(String(laneX(2)));
  });

  it("should centre the dot vertically at mid-height", () => {
    expect(dot(draw(2, [])).getAttribute("cy")).toBe(String(ROW_HEIGHT / 2));
  });

  it("should fill the dot with the lane colour", () => {
    expect(dot(draw(2, [])).getAttribute("fill")).toBe(laneColour(2));
  });

  it("should give the dot a positive radius", () => {
    expect(Number(dot(draw(0, [])).getAttribute("r"))).toBeGreaterThan(0);
  });
});

// Contract: decorative svg sized by the gutter, capped at MAX_DRAWN_LANES.
describe("LaneGraph svg", () => {
  it("should be hidden from assistive technology", () => {
    expect(svg(draw(0, [])).getAttribute("aria-hidden")).toBe("true");
  });

  it("should be as wide as the gutter for maxLanes", () => {
    expect(svg(draw(0, [], 3)).getAttribute("width")).toBe(String(gutterWidth(3)));
  });

  it("should stop growing past the drawn-lane cap", () => {
    expect(svg(draw(0, [], 40)).getAttribute("width")).toBe(String(gutterWidth(12)));
  });

  it("should be one row high", () => {
    expect(svg(draw(0, [])).getAttribute("height")).toBe(String(ROW_HEIGHT));
  });
});
