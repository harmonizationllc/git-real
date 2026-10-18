import type { FileDiff } from "../../lib/ipc";
import { KIND_WORDS, StatusBadge } from "../worktree/StatusBadge";
import styles from "./BinaryPlaceholder.module.css";

export function BinaryPlaceholder({ diff }: { diff: FileDiff }) {
  return (
    <div className={styles.root}>
      <p className={styles.text}>Binary file — no preview available</p>
      {diff.change && (
        <p className={styles.change}>
          <StatusBadge kind={diff.change} />
          <span className={styles.word} aria-hidden="true">
            {KIND_WORDS[diff.change]}
          </span>
        </p>
      )}
    </div>
  );
}
