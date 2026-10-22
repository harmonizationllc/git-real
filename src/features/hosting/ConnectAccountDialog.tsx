import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { openExternal, toAppError } from "../../lib/ipc";
import type { AppError, HostingAccount, HostingProvider } from "../../lib/ipc";
import type { AccountsPreset } from "./AccountsDialog";
import styles from "./ConnectAccountDialog.module.css";
import {
  DEFAULT_HOST,
  PROVIDER_LABEL,
  SCOPE_HINT,
  hostingErrorText,
  tokenPageUrl,
} from "./hostingCopy";
import { useAccountActions } from "./useAccountActions";

export interface ConnectAccountDialogProps {
  /** Starts the form on this provider and host (a reconnect, or the panel's Connect…). */
  preset?: AccountsPreset;
  /** The connected accounts, to confirm before replacing the one on the same host; undefined
   * while they load, which holds Connect back. */
  accounts: HostingAccount[] | undefined;
  onDone(account: HostingAccount): void;
  onCancel(): void;
}

const PROVIDERS: HostingProvider[] = ["github", "gitlab", "bitbucket"];

/**
 * Checks a personal access token with the provider and stores it in the system keychain. The token
 * stays in this component's state only, and is cleared the moment the form is submitted.
 */
export function ConnectAccountDialog({
  preset,
  accounts,
  onDone,
  onCancel,
}: ConnectAccountDialogProps) {
  const titleId = useId();
  const radioName = useId();
  const hostId = useId();
  const hostHintId = useId();
  const tokenId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const { connect, pending } = useAccountActions();
  const [provider, setProvider] = useState<HostingProvider>(preset?.provider ?? "github");
  const [host, setHost] = useState(preset?.host ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  const [replacing, setReplacing] = useState<HostingAccount | null>(null);

  // Bitbucket Cloud has one host, so its form has no Host field.
  const hasHost = provider !== "bitbucket";
  const typedHost = hasHost ? host.trim() : "";
  const resolvedHost = typedHost === "" ? DEFAULT_HOST[provider] : typedHost.toLowerCase();

  useRestoreFocus();
  // Token takes focus on open, after a failure and when the replace confirm closes (its own restore
  // runs while this box is still inert); while pending every control is disabled, so the dialog
  // holds it.
  useLayoutEffect(() => {
    if (replacing !== null) return;
    ((pending ? dialogRef.current : tokenRef.current) as HTMLElement).focus();
  }, [pending, error, replacing]);

  const send = async () => {
    const secret = token;
    setToken("");
    setError(null);
    const result = await connect(provider, typedHost === "" ? null : typedHost, secret);
    if ("error" in result) setError(result.error);
    else onDone(result.account);
  };

  // A disabled submit button blocks implicit submission, so an empty or pending form never gets here.
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Connect is disabled until the accounts have loaded.
    const existing = (accounts as HostingAccount[]).find(
      (a) => a.provider === provider && a.host === resolvedHost,
    );
    if (existing === undefined) void send();
    else setReplacing(existing);
  };

  const createToken = () =>
    void openExternal(tokenPageUrl(provider, resolvedHost)).catch((e: unknown) =>
      setError(toAppError(e)),
    );

  // A backdrop click does not cancel: it would throw away a pasted token.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onCancel();
  };

  // The replace confirm is a sibling after the box, so its Escape never reaches the box; inert
  // keeps focus and clicks out of the box meanwhile.
  return (
    <>
      <div className={styles.backdrop}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={styles.dialog}
          tabIndex={-1}
          inert={replacing !== null}
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId} className={styles.title}>
            Connect account
          </h2>
          <form className={styles.form} onSubmit={onSubmit}>
            <fieldset className={styles.providers} disabled={pending}>
              <legend>Provider</legend>
              {PROVIDERS.map((p) => (
                <label key={p} className={styles.check}>
                  <input
                    type="radio"
                    name={radioName}
                    value={p}
                    checked={provider === p}
                    onChange={() => setProvider(p)}
                  />
                  {PROVIDER_LABEL[p]}
                </label>
              ))}
            </fieldset>
            {hasHost && (
              <div className={styles.field}>
                <label htmlFor={hostId}>Host</label>
                <input
                  id={hostId}
                  type="text"
                  value={host}
                  placeholder={DEFAULT_HOST[provider]}
                  disabled={pending}
                  aria-describedby={hostHintId}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setHost(e.target.value)}
                />
                <p id={hostHintId} className={styles.note}>
                  Leave empty for {DEFAULT_HOST[provider]}.
                </p>
              </div>
            )}
            <div className={styles.field}>
              <label htmlFor={tokenId}>Token</label>
              <input
                ref={tokenRef}
                id={tokenId}
                type="password"
                value={token}
                disabled={pending}
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <p className={styles.note}>{SCOPE_HINT[provider]}</p>
            <div>
              <button type="button" disabled={pending} onClick={createToken}>
                Create a token
              </button>
            </div>
            {error !== null && (
              <p role="alert" className={styles.error}>
                {hostingErrorText(error, provider)}
              </p>
            )}
            <div className={styles.actions}>
              <button type="button" disabled={pending} onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" disabled={pending || token === "" || accounts === undefined}>
                {pending ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        </div>
      </div>
      {replacing !== null && (
        <ConfirmDialog
          open
          title={`Replace ${replacing.username} on ${replacing.host}?`}
          body="Only one account per host is supported. The old token is removed from the system keychain."
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            setReplacing(null);
            void send();
          }}
          onCancel={() => setReplacing(null)}
          fallbackFocus={dialogRef}
        />
      )}
    </>
  );
}
