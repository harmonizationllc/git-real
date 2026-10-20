import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import type { AppError } from "../lib/ipc";
import styles from "./PromptDialog.module.css";
import { useRestoreFocus } from "./useRestoreFocus";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  checkbox?: { label: string; checked: boolean; onChange(on: boolean): void };
  error: AppError | null;
  pending: boolean;
  /** Receives the trimmed, non-blank value. */
  onConfirm(value: string): void;
  onCancel(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

export function PromptDialog(props: PromptDialogProps) {
  // Mounting the body per open re-initialises the value from initialValue every time.
  return props.open ? <PromptDialogBody {...props} /> : null;
}

function PromptDialogBody({
  title,
  label,
  initialValue = "",
  confirmLabel = "Confirm",
  checkbox,
  error,
  pending,
  onConfirm,
  onCancel,
  fallbackFocus,
}: PromptDialogProps) {
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  // Focus and select the input on open; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    const input = inputRef.current as HTMLInputElement;
    input.focus();
    input.select();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the input when the action failed.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) (inputRef.current as HTMLInputElement).focus();
  }, [pending, error]);

  const blank = value.trim() === "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || blank) return;
    onConfirm(value.trim());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onCancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onCancel();
  };

  // No focus trap yet, consistent with ConfirmDialog; tracked as a GR-3 follow-up.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        ref={dialogRef}
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
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor={inputId}>{label}</label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={value}
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          {checkbox && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={checkbox.checked}
                disabled={pending}
                onChange={(e) => checkbox.onChange(e.target.checked)}
              />
              {checkbox.label}
            </label>
          )}
          {error && (
            <p id={errorId} role="alert" className={styles.error}>
              {error.message}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={pending || blank}>
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
