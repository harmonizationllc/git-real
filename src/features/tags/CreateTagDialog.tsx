import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import type { AppErrorKind, RepoId } from "../../lib/ipc";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { shortOid } from "../graph/model/layout";
import styles from "./CreateTagDialog.module.css";
import { createErrorText } from "./tagCopy";
import { useTagActions } from "./useTagActions";

export interface CreateTagDialogProps {
  repoId: RepoId;
  /** Full hex oid of the commit to tag. */
  oid: string;
  open: boolean;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

export function CreateTagDialog(props: CreateTagDialogProps) {
  // Mounting the body per open starts every open with an empty form and no error.
  return props.open ? (
    <CreateTagDialogBody
      repoId={props.repoId}
      oid={props.oid}
      onClose={props.onClose}
      fallbackFocus={props.fallbackFocus}
    />
  ) : null;
}

function CreateTagDialogBody({
  repoId,
  oid,
  onClose,
  fallbackFocus,
}: Omit<CreateTagDialogProps, "open">) {
  // Its own instance, so a create error stays in the dialog and never reaches the opener's panel.
  const actions = useTagActions(repoId);
  const { pending } = actions;
  const titleId = useId();
  const nameId = useId();
  const messageId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [annotated, setAnnotated] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<{ kind: AppErrorKind; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const blank = name.trim() === "" || (annotated && message.trim() === "");
  const messageError = error?.kind === "emptyMessage";

  useRestoreFocus(fallbackFocus);
  // Focus the name on open; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    (nameRef.current as HTMLInputElement).focus();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the field the error concerns.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null)
      ((error.kind === "emptyMessage" ? messageRef : nameRef).current as HTMLElement).focus();
  }, [pending, error]);

  const onSubmit = async (e: FormEvent) => {
    // No pending guard: Create is disabled while blank or pending, so the form cannot submit.
    e.preventDefault();
    // A retry starts clean, so a success never refocuses a field for a stale error.
    setError(null);
    const trimmed = name.trim();
    const result = await actions.create(trimmed, oid, annotated ? message : null);
    if (result === null) onClose();
    else setError({ kind: result.kind, text: createErrorText(result, trimmed) });
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
          {`Create tag on ${shortOid(oid)}`}
        </h2>
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.field}>
            <label htmlFor={nameId}>Name</label>
            <input
              ref={nameRef}
              id={nameId}
              type="text"
              value={name}
              disabled={pending}
              aria-describedby={error && !messageError ? errorId : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={annotated}
              disabled={pending}
              onChange={(e) => setAnnotated(e.target.checked)}
            />
            Annotated
          </label>
          {annotated && (
            <div className={styles.field}>
              <label htmlFor={messageId}>Message</label>
              <textarea
                ref={messageRef}
                id={messageId}
                rows={4}
                value={message}
                disabled={pending}
                aria-describedby={messageError ? errorId : undefined}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p id={errorId} role="alert" className={styles.error}>
              {error.text}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={blank || pending}>
              {pending ? "Working…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
