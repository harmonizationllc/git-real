import type { GraphEdge } from "../../../lib/ipc";
import { LANE_WIDTH, MAX_DRAWN_LANES, ROW_HEIGHT } from "./layout";

/** Horizontal centre of a lane column. */
export const laneX = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;

/**
 * SVG path of one edge within a row whose dot sits in column `lane` at mid-height.
 * A pass-through keeps its column (`top === bottom`, lanes are fixed slots), so it is a
 * vertical line; a join ends at the dot and a fork starts there, curving when the column differs.
 */
export function edgePath({ top, bottom }: GraphEdge, lane: number): string {
  const mid = ROW_HEIGHT / 2;
  const xl = laneX(lane);
  if (top !== null && bottom !== null) return `M ${laneX(top)} 0 V ${ROW_HEIGHT}`;
  if (top !== null) {
    const xk = laneX(top);
    return xk === xl
      ? `M ${xl} 0 V ${mid}`
      : `M ${xk} 0 C ${xk} ${mid / 2} ${xl} ${mid / 2} ${xl} ${mid}`;
  }
  const xk = laneX(bottom as number);
  return xk === xl
    ? `M ${xl} ${mid} V ${ROW_HEIGHT}`
    : `M ${xl} ${mid} C ${xl} ${mid * 1.5} ${xk} ${mid * 1.5} ${xk} ${ROW_HEIGHT}`;
}

/** Lane colours cycle through the eight `--graph-lane-*` tokens. */
export const laneColour = (col: number) => `var(--graph-lane-${col % 8})`;

/** Gutter width: at least one lane, at most MAX_DRAWN_LANES. */
export const gutterWidth = (maxLanes: number) =>
  Math.max(1, Math.min(maxLanes, MAX_DRAWN_LANES)) * LANE_WIDTH;
