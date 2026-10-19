import type { RefLabel } from "../../lib/ipc";
import { MAX_LABELS } from "./model/layout";
import styles from "./RefLabels.module.css";

export interface RefLabelsProps {
  refs: RefLabel[];
}

/** Ref pills for a row: up to MAX_LABELS, then a `+n` pill whose title lists the rest. */
export function RefLabels({ refs }: RefLabelsProps) {
  if (refs.length === 0) return null;
  const shown = refs.slice(0, MAX_LABELS);
  const hidden = refs.slice(MAX_LABELS);
  return (
    <span className={styles.root}>
      {shown.map((label) => (
        <span
          key={`${label.kind}:${label.name}`}
          className={`${styles.pill} ${styles[label.kind]} ${label.isHead ? styles.head : ""}`}
          title={label.name}
          aria-current={(label.kind === "branch" && label.isHead) || undefined}
        >
          {label.name}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className={`${styles.pill} ${styles.more}`}
          title={hidden.map((l) => l.name).join("\n")}
        >
          {`+${hidden.length}`}
        </span>
      )}
    </span>
  );
}
