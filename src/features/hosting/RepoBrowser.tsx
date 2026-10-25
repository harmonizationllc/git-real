import { useEffect, useId, useState } from "react";
import type { KeyboardEvent } from "react";
import type { HostedRepo } from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import type { CloneUrlForm } from "../../lib/store/layoutPrefs";
import { fullDate, relativeTime } from "../graph/model/relativeTime";
import { useNow } from "../graph/useNow";
import { NetworkError } from "../remotes/NetworkError";
import { networkMessage } from "../remotes/networkMessage";
import type { AccountsPreset } from "./AccountsDialog";
import { RECONNECT_TEXT, hostingMessage } from "./hostingCopy";
import styles from "./RepoBrowser.module.css";
import { useHostingAccounts } from "./useHostingAccounts";
import { useMyRepos } from "./useMyRepos";

/** How long typing must pause before the query reaches the provider. */
const DEBOUNCE_MS = 300;

const URL_FORMS: { form: CloneUrlForm; label: string }[] = [
  { form: "https", label: "HTTPS" },
  { form: "ssh", label: "SSH" },
];

export interface RepoBrowserProps {
  onPick(repo: HostedRepo): void;
  /** Opens the accounts dialog, which the parent renders outside its own dialog box. */
  onManageAccounts(preset?: AccountsPreset): void;
  disabled: boolean;
  /** The chosen account's id; null (or an id no longer connected) means the first account. */
  selectedAccountId: string | null;
  onSelectAccount(id: string): void;
}

/**
 * The connected account's repositories, searchable and a page at a time, with the HTTPS/SSH
 * preference. It sits inside the clone form, so nothing in it submits that form.
 */
export function RepoBrowser({
  onPick,
  onManageAccounts,
  disabled,
  selectedAccountId,
  onSelectAccount,
}: RepoBrowserProps) {
  const pickerId = useId();
  const { accounts, error: accountsError, refetch: refetchAccounts } = useHostingAccounts();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // The selection is derived: a disconnected account falls back to the first one, or to none.
  const account = accounts?.find((a) => a.id === selectedAccountId) ?? accounts?.[0] ?? null;
  const usable = account !== null && !account.needsReconnect;
  const list = useMyRepos(account?.id ?? null, debounced, usable);
  const form = useLayoutPrefs((s) => s.cloneUrlForm);
  const setForm = useLayoutPrefs((s) => s.setCloneUrlForm);
  const now = useNow();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Every hook runs above. Before the accounts answer there is no provider to name, so a failure
  // gets the general network copy.
  if (accounts === undefined) {
    return accountsError === null ? (
      <p role="status">Loading…</p>
    ) : (
      <NetworkError message={networkMessage(accountsError)} onDismiss={refetchAccounts} />
    );
  }

  if (account === null) {
    return (
      <div className={styles.notice}>
        <p className={styles.empty}>Connect a hosting account to browse your repositories</p>
        <button type="button" onClick={() => onManageAccounts()}>
          Hosting accounts…
        </button>
      </div>
    );
  }

  const provider = account.provider;
  // A 401 marks the account in the store but does not refetch the accounts, so the list's own
  // hostingAuth counts too.
  const reconnect = account.needsReconnect || list.error?.kind === "hostingAuth";

  // Enter in the search or on a radio would otherwise submit the clone form around the browser.
  const onEnterKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") e.preventDefault();
  };

  // Escape clears a search first and stays here; on an empty one it reaches the dialog.
  const onSearchKeyDown = (e: KeyboardEvent) => {
    onEnterKeyDown(e);
    // An Escape that cancels an IME composition belongs to the composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && query !== "") {
      setQuery("");
      e.stopPropagation();
    }
  };

  // A failed Show more keeps what loaded and offers a retry.
  const moreError = list.error !== null && (
    <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />
  );
  const showMore = list.hasMore && (
    <button type="button" disabled={list.loadingMore} onClick={list.loadMore}>
      {list.loadingMore ? "Loading…" : "Show more"}
    </button>
  );

  const repos = list.repos;
  let body: React.ReactNode;
  if (list.error !== null && repos === undefined) {
    // Nothing loaded yet: the error stands in for the list. A failed Show more keeps the list.
    body = <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />;
  } else if (repos === undefined) {
    body = <p role="status">Loading repositories…</p>;
  } else if (repos.length === 0) {
    // A full raw page whose rows were all dropped is empty but may have more.
    body = (
      <>
        <p className={styles.empty}>
          {debounced === "" ? "No repositories" : "No repositories match"}
        </p>
        {moreError}
        {showMore}
      </>
    );
  } else {
    body = (
      <>
        <ul aria-label="Repositories" className={styles.list}>
          {repos.map((repo) => (
            <li key={repo.fullName}>
              <button
                type="button"
                className={styles.row}
                aria-label={`Use ${repo.fullName}`}
                disabled={disabled}
                onClick={() => onPick(repo)}
              >
                <span className={styles.line}>
                  <span className={styles.name}>{repo.name}</span>
                  <span className={styles.owner}>{repo.owner}</span>
                  {repo.private && <span className={styles.badge}>Private</span>}
                </span>
                {repo.description !== null && (
                  <span className={styles.description}>{repo.description}</span>
                )}
                <span className={styles.updated} title={fullDate(repo.updatedAt)}>
                  {`Updated ${relativeTime(repo.updatedAt, now * 1000)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {moreError}
        {showMore}
      </>
    );
  }

  return (
    <div className={styles.root}>
      {accounts.length > 1 && (
        <div className={styles.field}>
          <label htmlFor={pickerId}>Account</label>
          <select
            id={pickerId}
            value={account.id}
            disabled={disabled}
            onChange={(e) => onSelectAccount(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {`${a.username} on ${a.host}`}
              </option>
            ))}
          </select>
        </div>
      )}
      {reconnect ? (
        <div className={styles.notice}>
          <p className={styles.empty}>{RECONNECT_TEXT}</p>
          <button type="button" onClick={() => onManageAccounts({ provider, host: account.host })}>
            Reconnect
          </button>
        </div>
      ) : (
        <>
          <input
            type="search"
            aria-label="Search repositories"
            placeholder="Type to search"
            value={query}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            className={styles.search}
            onKeyDown={onSearchKeyDown}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div
            role="radiogroup"
            aria-label="Clone with"
            className={styles.forms}
            onKeyDown={onEnterKeyDown}
          >
            {URL_FORMS.map(({ form: value, label }) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${pickerId}-form`}
                  value={value}
                  checked={form === value}
                  disabled={disabled}
                  onChange={() => setForm(value)}
                />{" "}
                {label}
              </label>
            ))}
          </div>
          {body}
        </>
      )}
    </div>
  );
}
