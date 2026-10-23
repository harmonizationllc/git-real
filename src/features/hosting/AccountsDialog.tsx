import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { AppError, HostingAccount, HostingProvider } from "../../lib/ipc";
import styles from "./AccountsDialog.module.css";
import { ConnectAccountDialog } from "./ConnectAccountDialog";
import { RECONNECT_TEXT, hostingErrorText } from "./hostingCopy";
import { useAccountActions } from "./useAccountActions";
import { useHostingAccounts } from "./useHostingAccounts";

/** The provider and host the connect form starts on. */
export interface AccountsPreset {
  provider: HostingProvider;
  host: string;
}

export interface AccountsDialogProps {
  open: boolean;
  onClose(): void;
  /** Opens straight into the connect form, set to this provider and host. */
  preset?: AccountsPreset;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

type View = { kind: "list" } | { kind: "connect"; preset?: AccountsPreset };

/** Lists, connects and disconnects hosting accounts. */
export function AccountsDialog({ open, onClose, preset, fallbackFocus }: AccountsDialogProps) {
  return open ? (
    <>
      <RestoreFocus fallbackFocus={fallbackFocus} />
      <AccountsDialogBody onClose={onClose} preset={preset} />
    </>
  ) : null;
}

/**
 * A sibling before the body, so it records the opener before a preset's connect form (a child of
 * the body, whose layout effects run first) moves focus to its token field.
 */
function RestoreFocus({ fallbackFocus }: { fallbackFocus?: RefObject<HTMLElement | null> }) {
  useRestoreFocus(fallbackFocus);
  return null;
}

function AccountsDialogBody({ onClose, preset }: { onClose(): void; preset?: AccountsPreset }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { accounts, error: loadError } = useHostingAccounts();
  const { disconnect, pending } = useAccountActions();
  const [view, setView] = useState<View>(() =>
    preset ? { kind: "connect", preset } : { kind: "list" },
  );
  const [removing, setRemoving] = useState<HostingAccount | null>(null);
  // A failed disconnect, with the provider its copy names.
  const [removeError, setRemoveError] = useState<{
    error: AppError;
    provider: HostingProvider;
  } | null>(null);

  const nested = view.kind === "connect" || removing !== null;

  // Focus the box on open and again when a nested dialog closes: the nested dialog's own restore
  // runs while the box is still inert, so it cannot hand focus back to its opener.
  useLayoutEffect(() => {
    if (!nested) (dialogRef.current as HTMLDivElement).focus();
  }, [nested]);

  const confirmRemove = async (account: HostingAccount) => {
    setRemoveError(null);
    const error = await disconnect(account.id);
    setRemoving(null);
    if (error !== null) setRemoveError({ error, provider: account.provider });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  const reconnect = (a: HostingAccount) =>
    setView({ kind: "connect", preset: { provider: a.provider, host: a.host } });

  let list: React.ReactNode = null;
  if (loadError !== null) {
    list = (
      <p role="alert" className={styles.error}>
        {loadError.message}
      </p>
    );
  } else if (accounts?.length === 0) {
    list = <p className={styles.empty}>No accounts connected</p>;
  } else if (accounts !== undefined) {
    list = (
      <ul aria-label="Accounts" className={styles.list}>
        {accounts.map((a) => (
          <li key={a.id} className={styles.row}>
            {/* Provider avatars cannot load under the CSP, so the initial stands in. */}
            <span className={styles.avatar} aria-hidden="true">
              {a.username.charAt(0).toUpperCase()}
            </span>
            <div className={styles.info}>
              <span className={styles.name}>{a.displayName ?? a.username}</span>
              <span className={styles.meta}>
                {a.username} on {a.host}
              </span>
              {a.needsReconnect && <span className={styles.warning}>{RECONNECT_TEXT}</span>}
            </div>
            <div className={styles.rowActions}>
              {a.needsReconnect && (
                <button
                  type="button"
                  aria-label={`Reconnect ${a.username} on ${a.host}`}
                  onClick={() => reconnect(a)}
                >
                  Reconnect
                </button>
              )}
              <button
                type="button"
                aria-label={`Disconnect ${a.username} on ${a.host}`}
                disabled={pending}
                onClick={() => setRemoving(a)}
              >
                Disconnect
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // The nested dialogs are siblings after the box, so their Escape never reaches it; the box stays
  // mounted (inert) so the button that opened them can take focus back.
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
          inert={nested}
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId} className={styles.title}>
            Hosting accounts
          </h2>
          {removeError !== null && (
            <p role="alert" className={styles.error}>
              {hostingErrorText(removeError.error, removeError.provider)}
            </p>
          )}
          {list}
          <div className={styles.actions}>
            <button type="button" onClick={() => setView({ kind: "connect" })}>
              Connect account…
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
      {view.kind === "connect" && (
        <ConnectAccountDialog
          preset={view.preset}
          accounts={accounts}
          onDone={() => setView({ kind: "list" })}
          onCancel={() => setView({ kind: "list" })}
        />
      )}
      {removing !== null && (
        <ConfirmDialog
          open
          title={`Disconnect ${removing.username} from ${removing.host}?`}
          body="The token is removed from the system keychain."
          confirmLabel="Disconnect"
          danger
          pending={pending}
          onConfirm={() => void confirmRemove(removing)}
          onCancel={() => setRemoving(null)}
          fallbackFocus={dialogRef}
        />
      )}
    </>
  );
}
