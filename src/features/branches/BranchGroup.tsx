import { useId } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
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
  /** Makes the heading focusable with a context menu (pointer or Shift+F10 / ContextMenu key). */
  onHeadingContextMenu?(x: number, y: number): void;
}

export function BranchGroup({
  heading,
  listLabel,
  filtered,
  children,
  count,
  leading,
  onHeadingContextMenu,
}: BranchGroupProps) {
  const headingId = useId();
  // The same keyboard rule as BranchRow: the menu opens at the heading's bottom-left.
  const menuProps = onHeadingContextMenu && {
    tabIndex: 0,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      onHeadingContextMenu(e.clientX, e.clientY);
    },
    onKeyDown: (e: KeyboardEvent<HTMLHeadingElement>) => {
      if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
        // Without this WebKit also fires a native contextmenu, opening the menu twice.
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onHeadingContextMenu(r.left, r.bottom);
      }
    },
  };
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
      <h2 id={headingId} className={styles.heading} {...menuProps}>
        {heading}
      </h2>
      {leading}
      {content}
    </section>
  );
}
