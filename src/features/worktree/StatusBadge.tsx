import type { ChangeKind } from "../../lib/ipc";
import styles from "./StatusBadge.module.css";

export interface StatusBadgeProps {
  kind: ChangeKind;
}

const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typeChange: "T",
  untracked: "U",
  conflicted: "C",
};

export const KIND_WORDS: Record<ChangeKind, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  typeChange: "type change",
  untracked: "untracked",
  conflicted: "conflicted",
};

export function StatusBadge({ kind }: StatusBadgeProps) {
  return (
    <span role="img" aria-label={KIND_WORDS[kind]} data-kind={kind} className={styles.badge}>
      {LETTER[kind]}
    </span>
  );
}
