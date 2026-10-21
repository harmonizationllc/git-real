import type { KeyboardEvent } from "react";
import type { TagEntry } from "../../lib/ipc";
import { shortOid } from "../graph/model/layout";
import { fullDate } from "../graph/model/relativeTime";
import styles from "./TagRow.module.css";

export interface TagRowProps {
  tag: TagEntry;
  onSelect(): void;
  onContextMenu(x: number, y: number): void;
}

export function TagRow({ tag, onSelect, onContextMenu }: TagRowProps) {
  // Enter and Space select through the native button click.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      // Without this WebKit also fires a native contextmenu on the row, opening the menu twice.
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onContextMenu(r.left, r.bottom);
    }
  };

  return (
    <li
      className={styles.item}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className={styles.row}
        title={fullDate(tag.time)}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className={styles.name}>{tag.name}</span>
        <span className={styles.meta}>
          <code>{shortOid(tag.target)}</code>
          {tag.annotated && (
            <span className={styles.marker} title={tag.subject ?? undefined}>
              annotated
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
