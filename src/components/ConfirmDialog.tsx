import { useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import styles from "./ConfirmDialog.module.css";
import { useRestoreFocus } from "./useRestoreFocus";

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
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
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
  fallbackFocus,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  // null, undefined and false (from `cond && <p/>`) all mean no description.
  const hasBody = body != null && body !== false;

  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  // Cancel takes focus on open and again when a pending action ends with the dialog still open;
  // while pending every button is disabled, so the dialog itself holds focus.
  useLayoutEffect(() => {
    ((pending ? dialogRef.current : cancelRef.current) as HTMLElement).focus();
  }, [pending]);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasBody ? bodyId : undefined}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {hasBody && (
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
