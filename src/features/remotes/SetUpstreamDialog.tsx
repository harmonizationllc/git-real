import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { AppError } from "../../lib/ipc";
import styles from "./SetUpstreamDialog.module.css";

export interface SetUpstreamDialogProps {
  remotes: string[];
  branch: string;
  error: AppError | null;
  pending: boolean;
  onPublish(remote: string, branch: string): void;
  onCancel(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

const errorText = (error: AppError, name: string) =>
  error.kind === "invalidBranchName" ? `${name} is not a valid branch name.` : error.message;

/** Publishes a branch that has no upstream: pick the remote and the remote branch name. */
export function SetUpstreamDialog({
  remotes,
  branch,
  error,
  pending,
  onPublish,
  onCancel,
  fallbackFocus,
}: SetUpstreamDialogProps) {
  const titleId = useId();
  const remoteId = useId();
  const nameId = useId();
  const errorId = useId();
  const [remote, setRemote] = useState(remotes.includes("origin") ? "origin" : remotes[0]);
  const [name, setName] = useState(branch);
  // The inline error names what was sent, not what has been typed since.
  const [submitted, setSubmitted] = useState(branch);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    const input = nameRef.current as HTMLInputElement;
    input.focus();
    input.select();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the name field when the publish failed.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) (nameRef.current as HTMLInputElement).focus();
  }, [pending, error]);

  const blank = name.trim() === "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // While pending every control is disabled, so only a blank name needs refusing here.
    if (blank) return;
    setSubmitted(name.trim());
    onPublish(remote, name.trim());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onCancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onCancel();
  };

  // No focus trap yet, consistent with PromptDialog; tracked as a GR-3 follow-up.
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
          Publish {branch}
        </h2>
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor={remoteId}>Remote</label>
            <select
              id={remoteId}
              className={styles.select}
              value={remote}
              disabled={pending}
              onChange={(e) => setRemote(e.target.value)}
            >
              {remotes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={nameId}>Branch name</label>
            <input
              ref={nameRef}
              id={nameId}
              type="text"
              value={name}
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <p id={errorId} role="alert" className={styles.error}>
              {errorText(error, submitted)}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={pending || blank}>
              {pending ? "Working…" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
