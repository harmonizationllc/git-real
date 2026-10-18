import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent } from "react";
import type { AppError } from "../lib/ipc";
import styles from "./PromptDialog.module.css";

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
}: PromptDialogProps) {
  const titleId = useId();
  const inputId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select the input on open and restore focus on close, in one layout effect so it is
  // StrictMode-safe and the restore runs before another dialog's autoFocus.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const input = inputRef.current as HTMLInputElement;
    input.focus();
    input.select();
    return () => previous.focus();
  }, []);

  const blank = value.trim() === "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || blank) return;
    onConfirm(value.trim());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onCancel();
  };

  // No focus trap yet, consistent with ConfirmDialog; tracked as a GR-3 follow-up.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
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
            <p role="alert" className={styles.error}>
              {error.message}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={onCancel}>
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
