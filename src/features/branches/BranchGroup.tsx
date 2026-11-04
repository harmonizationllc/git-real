import { useId } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import styles from "./BranchGroup.module.css";

export interface BranchGroupBodyProps {
  listLabel: string;
  /** True while a filter query is applied, so an empty group reads "No matches". */
  filtered: boolean;
  children: ReactNode;
  count: number;
  /** A non-interactive row shown before the list, e.g. a detached or unborn HEAD. */
  leading?: ReactNode;
}

export interface BranchGroupProps extends BranchGroupBodyProps {
  heading: string;
  /** Makes the heading focusable with a context menu (pointer or Shift+F10 / ContextMenu key). */
  onHeadingContextMenu?(x: number, y: number): void;
}

/** A group's rows: the leading row, then the list or its empty copy. */
export function BranchGroupBody({
  listLabel,
  filtered,
  children,
  count,
  leading,
}: BranchGroupBodyProps) {
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
    <>
      {leading}
      {content}
    </>
  );
}

/** A headed group of branch rows, e.g. one remote's branches inside the Remote section. */
export function BranchGroup({ heading, onHeadingContextMenu, ...body }: BranchGroupProps) {
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
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <h3 id={headingId} className="gr-section-heading" data-sub {...menuProps}>
        {heading}
      </h3>
      <BranchGroupBody {...body} />
    </section>
  );
}

export interface BranchSectionHeaderProps {
  /** The toggle's text, e.g. "Local (3)". */
  label: string;
  expanded: boolean;
  /** The id of the body the toggle shows and hides. */
  bodyId: string;
  onToggle(): void;
  /** Buttons at the right of the heading, on the same row. */
  children?: ReactNode;
}

/** A column section's header row: a level-2 heading holding the collapse toggle, then buttons. */
export function BranchSectionHeader({
  label,
  expanded,
  bodyId,
  onToggle,
  children,
}: BranchSectionHeaderProps) {
  return (
    <div className={`gr-section-header ${styles.header}`}>
      <h2 className={`gr-section-heading ${styles.heading}`}>
        <button
          type="button"
          className="gr-section-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          {label}
        </button>
      </h2>
      {children}
    </div>
  );
}
