import { useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import styles from "./DetailsDialog.module.css";
import { useRestoreFocus } from "./useRestoreFocus";

export interface DetailsDialogProps {
  open: boolean;
  title: string;
  /** Raw output, shown verbatim. */
  details: string;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** A modal that shows the raw output behind a notice, with Copy and Close. */
export function DetailsDialog(props: DetailsDialogProps) {
  return props.open ? <DetailsDialogBody {...props} /> : null;
}

function DetailsDialogBody({ title, details, onClose, fallbackFocus }: DetailsDialogProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
  const copy = () => {
    // A denied or missing clipboard has no recovery here; the text stays selectable in the pre.
    void navigator.clipboard?.writeText(details)?.catch(() => undefined);
  };

  // A portal, so a dialog opened from a toast sits outside the toasts' polite live region and
  // their pointer-events: none stack.
  return createPortal(
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <pre className={styles.details}>{details}</pre>
        <div className={styles.actions}>
          <button type="button" data-variant="neutral" onClick={copy}>
            Copy
          </button>
          <button ref={closeRef} type="button" data-variant="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
