import { useId } from "react";
import type { ReactNode } from "react";
import styles from "./BranchGroup.module.css";

export interface BranchGroupProps {
  heading: string;
  listLabel: string;
  /** True while a filter query is applied, so an empty group reads "No matches". */
  filtered: boolean;
  children: ReactNode;
  count: number;
  /** A non-interactive row shown before the list, e.g. a detached or unborn HEAD. */
  leading?: ReactNode;
}

export function BranchGroup({
  heading,
  listLabel,
  filtered,
  children,
  count,
  leading,
}: BranchGroupProps) {
  const headingId = useId();
  let content: ReactNode = null;
  if (count > 0) {
    content = (
      <ul aria-label={listLabel} className={styles.list}>
        {children}
      </ul>
    );
  } else if (filtered) {
    content = <p className={styles.empty}>No matches</p>;
  } else if (leading === undefined) {
    // A leading row already stands for the HEAD of an otherwise empty group.
    content = <p className={styles.empty}>No branches</p>;
  }
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {heading}
      </h2>
      {leading}
      {content}
    </section>
  );
}
