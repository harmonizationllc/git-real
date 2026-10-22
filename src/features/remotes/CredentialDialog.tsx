import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import styles from "./CredentialDialog.module.css";
import { tokenHint } from "./remoteCopy";
import type { CredentialPrompt } from "./useNetworkAction";

export interface CredentialDialogProps {
  prompt: CredentialPrompt | null;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** Asks for a username and token when git needs HTTPS credentials. */
export function CredentialDialog({ prompt, fallbackFocus }: CredentialDialogProps) {
  return prompt === null ? null : (
    <CredentialDialogBody prompt={prompt} fallbackFocus={fallbackFocus} />
  );
}

function CredentialDialogBody({
  prompt,
  fallbackFocus,
}: {
  prompt: CredentialPrompt;
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const userId = useId();
  const tokenId = useId();
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const userRef = useRef<HTMLInputElement>(null);

  // Each ask builds a new prompt: a rejected retry starts again with empty fields.
  const [shown, setShown] = useState(prompt);
  if (shown !== prompt) {
    setShown(prompt);
    setUsername("");
    setToken("");
  }

  useRestoreFocus(fallbackFocus);
  // Focus Username on open and again for each new prompt; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    (userRef.current as HTMLInputElement).focus();
  }, [prompt]);

  const ready = username.trim() !== "" && token !== "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) prompt.submit(username.trim(), token);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") prompt.cancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) prompt.cancel();
  };

  // No focus trap yet, consistent with PromptDialog; tracked as a GR-3 follow-up.
  return (
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
          Sign in to {prompt.host}
        </h2>
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor={userId}>Username</label>
            <input
              ref={userRef}
              id={userId}
              type="text"
              value={username}
              spellCheck={false}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={tokenId}>Token or password</label>
            <input
              id={tokenId}
              type="password"
              value={token}
              autoComplete="current-password"
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <p className={styles.note}>{tokenHint(prompt.host)}</p>
          <p className={styles.note}>
            Your git credential helper will store these if one is configured.
          </p>
          {prompt.rejected && (
            <p role="alert" className={styles.error}>
              Those credentials were rejected
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={prompt.cancel}>
              Cancel
            </button>
            <button type="submit" disabled={!ready}>
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
