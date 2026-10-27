import type { GraphRow as GraphRowData } from "../../lib/ipc";
import { LaneGraph } from "./LaneGraph";
import { MESSAGE_GAP_PX } from "./model/layout";
import { fullDate, relativeTime } from "./model/relativeTime";
import { RefLabels } from "./RefLabels";
import styles from "./GraphRow.module.css";

export interface GraphRowProps {
  row: GraphRowData;
  /** The current time in Unix seconds; the row never reads the clock itself. */
  now: number;
  maxLanes: number;
  selected: boolean;
  matched: boolean;
  id: string;
  onSelect(): void;
  onContextMenu(x: number, y: number): void;
}

export function GraphRow({
  row,
  now,
  maxLanes,
  selected,
  matched,
  id,
  onSelect,
  onContextMenu,
}: GraphRowProps) {
  const classes = [styles.row, selected && styles.selected, matched && styles.matched];
  return (
    <div
      role="option"
      id={id}
      aria-selected={selected}
      className={classes.filter(Boolean).join(" ")}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <LaneGraph row={row} maxLanes={maxLanes} />
      <span className={styles.message} style={{ gap: MESSAGE_GAP_PX }}>
        <RefLabels refs={row.refs} />
        <span className={styles.subject}>{row.subject}</span>
      </span>
      <span className={styles.author} title={row.authorEmail}>
        {row.authorName}
      </span>
      <span className={styles.date} title={fullDate(row.authorTime)}>
        {relativeTime(row.authorTime, now * 1000)}
      </span>
    </div>
  );
}
