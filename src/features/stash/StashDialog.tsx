import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent } from "react";
import type { AppError, RepoId } from "../../lib/ipc";
import styles from "./StashDialog.module.css";
import { displayError } from "./stashCopy";
import { useStashActions } from "./useStashActions";

export interface StashDialogProps {
  repoId: RepoId;
  open: boolean;
  onClose(): void;
}

export function StashDialog(props: StashDialogProps) {
  // Mounting the body per open starts every open with an empty form and no error.
  return props.open ? <StashDialogBody repoId={props.repoId} onClose={props.onClose} /> : null;
}

function StashDialogBody({ repoId, onClose }: Omit<StashDialogProps, "open">) {
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

  // Focus the input on open and restore focus on close, as PromptDialog does.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (inputRef.current as HTMLInputElement).focus();
    return () => previous.focus();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    // No pending guard: the input and submit button are disabled, so the form cannot submit.
    e.preventDefault();
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
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
