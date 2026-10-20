import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import type { AppError, RepoId } from "../../lib/ipc";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import styles from "./StashDialog.module.css";
import { displayError } from "./stashCopy";
import { useStashActions } from "./useStashActions";

export interface StashDialogProps {
  repoId: RepoId;
  open: boolean;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

export function StashDialog(props: StashDialogProps) {
  // Mounting the body per open starts every open with an empty form and no error.
  return props.open ? (
    <StashDialogBody
      repoId={props.repoId}
      onClose={props.onClose}
      fallbackFocus={props.fallbackFocus}
    />
  ) : null;
}

function StashDialogBody({ repoId, onClose, fallbackFocus }: Omit<StashDialogProps, "open">) {
  // Its own instance, so a push error stays in the dialog and never reaches the opener's panel.
  const actions = useStashActions(repoId);
  const { pending } = actions;
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  // Focus the input on open; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    (inputRef.current as HTMLInputElement).focus();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the message field when the push failed.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) (inputRef.current as HTMLInputElement).focus();
  }, [pending, error]);

  const onSubmit = async (e: FormEvent) => {
    // No pending guard: the input and submit button are disabled, so the form cannot submit.
    e.preventDefault();
    // A retry starts clean, so a success never refocuses the field for a stale error.
    setError(null);
    const trimmed = message.trim();
    const result = await actions.push(trimmed === "" ? null : trimmed, includeUntracked);
    if (result === null) onClose();
    else setError(displayError(result));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onClose();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onClose();
  };

  // No focus trap yet, consistent with ConfirmDialog and PromptDialog.
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
          Stash changes
        </h2>
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.field}>
            <label htmlFor={inputId}>Message</label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={message}
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
              autoComplete="off"
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={pending}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            Include untracked files
          </label>
          {error && (
            <p id={errorId} role="alert" className={styles.error}>
              {error.message}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending}>
              {pending ? "Working…" : "Stash"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
