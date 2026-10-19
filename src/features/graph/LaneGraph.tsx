import type { GraphRow } from "../../lib/ipc";
import { edgePath, gutterWidth, laneColour, laneX } from "./model/edges";
import { ROW_HEIGHT } from "./model/layout";
import styles from "./LaneGraph.module.css";

export interface LaneGraphProps {
  row: GraphRow;
  /** The widest lane count of the log; sizes the gutter so every row lines up. */
  maxLanes: number;
}

const DOT_RADIUS = 4;

/** One row's slice of the graph: its edges and the commit dot; lanes past the cap are clipped. */
export function LaneGraph({ row, maxLanes }: LaneGraphProps) {
  const width = gutterWidth(maxLanes);
  return (
    <svg
      aria-hidden="true"
      className={styles.root}
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
    >
      {row.edges.map((edge, i) => (
        <path
          key={i}
          d={edgePath(edge, row.lane)}
          stroke={laneColour(edge.top ?? (edge.bottom as number))}
          fill="none"
          strokeWidth={2}
        />
      ))}
      <circle cx={laneX(row.lane)} cy={ROW_HEIGHT / 2} r={DOT_RADIUS} fill={laneColour(row.lane)} />
    </svg>
  );
}
