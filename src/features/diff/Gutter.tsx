import styles from "./DiffRows.module.css";

/** One line-number cell. */
export function Gutter({ lineno }: { lineno: number | null }) {
  return <span className={styles.gutter}>{lineno}</span>;
}
