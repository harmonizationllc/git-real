import { useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import styles from "./ConfirmDialog.module.css";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Block content is allowed; it is the dialog's accessible description. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Disables both buttons and ignores Escape and backdrop clicks; confirm reads "Working…". */
  pending?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <ConfirmDialogBody {...props} /> : null;
}

function ConfirmDialogBody({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();

  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus Cancel on open and restore focus on close, in one layout effect so it is StrictMode-safe
  // and the restore runs before another dialog's autoFocus.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (cancelRef.current as HTMLButtonElement).focus();
    return () => previous.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onCancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onCancel();
  };

  // No focus trap yet, consistent with the clone dialog; tracked as a GR-3 follow-up.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body == null ? undefined : bodyId}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {body != null && (
          <div id={bodyId} className={styles.body}>
            {body}
          </div>
        )}
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={styles.confirm}
            data-danger={danger ? "true" : undefined}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
