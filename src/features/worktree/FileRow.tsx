import type { ChangeKind, StatusEntry } from "../../lib/ipc";
import styles from "./FileRow.module.css";
import { KIND_WORDS, StatusBadge } from "./StatusBadge";

export type Section = "conflicts" | "staged" | "unstaged";

export interface FileRowProps {
  entry: StatusEntry;
  section: Section;
  /** The kind this section shows for the entry; the panel owns the section rules. */
  kind: ChangeKind;
  selected: boolean;
  disabled: boolean;
  onClick(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void;
  onContextMenu(x: number, y: number): void;
  onPrimary(): void;
  onDiscard?(): void;
}

export function FileRow({
  entry,
  section,
  kind,
  selected,
  disabled,
  onClick,
  onContextMenu,
  onPrimary,
  onDiscard,
}: FileRowProps) {
  const { path, oldPath } = entry;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const primary = section === "staged" ? "Unstage" : "Stage";
  const renamedFrom = kind === "renamed" ? oldPath : null;
  const display = renamedFrom === null ? path : `${renamedFrom} → ${path}`;

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
        aria-pressed={selected}
        aria-label={`${KIND_WORDS[kind]} ${display}`}
        onClick={({ ctrlKey, metaKey, shiftKey }) => onClick({ ctrlKey, metaKey, shiftKey })}
      >
        <StatusBadge kind={kind} />{" "}
        <span className={styles.path}>
          {renamedFrom !== null && <span className={styles.muted}>{`${renamedFrom} → `}</span>}
          {dir !== "" && <span className={styles.muted}>{dir}</span>}
          <span>{name}</span>
        </span>
      </button>
      <button
        type="button"
        className={styles.action}
        aria-label={`${primary} ${path}`}
        disabled={disabled}
        onClick={onPrimary}
      >
        {primary}
      </button>
      {onDiscard && (
        <button
          type="button"
          className={styles.action}
          aria-label={`Discard ${path}`}
          disabled={disabled}
          onClick={onDiscard}
        >
          Discard
        </button>
      )}
    </li>
  );
}
