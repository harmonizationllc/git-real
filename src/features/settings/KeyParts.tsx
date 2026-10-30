import styles from "./KeyParts.module.css";

/** A chord's `<kbd>` parts, or `Unbound` when `parts` is `null`. */
export function KeyParts({ parts }: { parts: string[] | null }) {
  if (parts === null) return <span className={styles.unbound}>Unbound</span>;
  return parts.map((part, i) => (
    <kbd key={i} className={styles.kbd}>
      {part}
    </kbd>
  ));
}
