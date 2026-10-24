import { useCallback, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { PullRequest, RepoId } from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import { CredentialDialog } from "../remotes/CredentialDialog";
import { NetworkError } from "../remotes/NetworkError";
import { AccountsDialog } from "./AccountsDialog";
import type { AccountsPreset } from "./AccountsDialog";
import { PROVIDER_LABEL, RECONNECT_TEXT, hostingMessage, prCountLabel } from "./hostingCopy";
import { PullRequestRow } from "./PullRequestRow";
import styles from "./PullRequestsPanel.module.css";
import { usePrActions } from "./usePrActions";
import { usePullRequests } from "./usePullRequests";
import { useRepoContext } from "./useRepoContext";

export interface PullRequestsPanelProps {
  repoId: RepoId;
  /** Opens the create pull request dialog; null or absent disables the header button. */
  onCreatePullRequest?: (() => void) | null;
}

interface MenuState {
  x: number;
  y: number;
  pr: PullRequest;
}

/** The open pull requests of the hosted repository behind `origin`; absent for any other origin. */
export function PullRequestsPanel({ repoId, onCreatePullRequest }: PullRequestsPanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { context } = useRepoContext(repoId);
  const collapsed = useLayoutPrefs((s) => s.pullRequestsCollapsed);
  const account = context?.account ?? null;
  const usable = account !== null && !account.needsReconnect;
  const list = usePullRequests(repoId, !collapsed && usable);
  const actions = usePrActions(repoId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [accountsPreset, setAccountsPreset] = useState<AccountsPreset | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Every hook runs above: the section exists only for a hosted origin.
  if (!context) return null;

  const { repo } = context;
  const provider = repo.provider;
  const openAccounts = () => setAccountsPreset({ provider, host: repo.host });
  const reconnect = account?.needsReconnect === true || list.error?.kind === "hostingAuth";
  const prs = list.pullRequests;

  const menuItems = (pr: PullRequest): MenuItem[] => [
    {
      id: "checkout",
      label: "Check out",
      disabled: actions.pending,
      onSelect: () => void actions.checkout(pr),
    },
    { id: "open", label: "Open in browser", onSelect: () => actions.open(pr) },
    { id: "copy", label: "Copy link", onSelect: () => actions.copyLink(pr) },
  ];

  let body: React.ReactNode;
  if (collapsed) {
    body = null;
  } else if (account === null) {
    body = (
      <div className={styles.notice}>
        <p className={styles.empty}>
          Connect your {PROVIDER_LABEL[provider]} account to see pull requests
        </p>
        <button type="button" onClick={openAccounts}>
          Connect…
        </button>
      </div>
    );
  } else if (reconnect) {
    body = (
      <div className={styles.notice}>
        <p className={styles.empty}>{RECONNECT_TEXT}</p>
        <button type="button" onClick={openAccounts}>
          Reconnect
        </button>
      </div>
    );
  } else if (list.error !== null && prs === undefined) {
    // Nothing loaded yet: the error stands in for the list. A failed Show more keeps the list.
    body = <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />;
  } else if (prs === undefined) {
    body = <p role="status">Loading pull requests…</p>;
  } else if (prs.length === 0) {
    body = <p className={styles.empty}>No open pull requests</p>;
  } else {
    body = (
      <>
        <ul aria-label="Pull request list" className={styles.list}>
          {prs.map((pr) => (
            <PullRequestRow
              key={pr.number}
              pr={pr}
              onOpen={() => actions.open(pr)}
              onContextMenu={(x, y) => setMenu({ x, y, pr })}
            />
          ))}
        </ul>
        {list.error !== null && (
          <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />
        )}
        {list.hasMore && (
          <button
            type="button"
            className={styles.more}
            disabled={list.loadingMore}
            onClick={list.loadMore}
          >
            {list.loadingMore ? "Loading…" : "Show more"}
          </button>
        )}
      </>
    );
  }

  const reset = actions.resetRequest;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={actions.pending || undefined}
      className={styles.root}
    >
      <div className={styles.header}>
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          data-focus-target
          className={styles.heading}
        >
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => useLayoutPrefs.getState().setPullRequestsCollapsed(!collapsed)}
          >
            {prCountLabel(prs?.length ?? null, list.hasMore)}
          </button>
        </h2>
        <button
          type="button"
          className={styles.create}
          aria-label="Create pull request"
          disabled={!onCreatePullRequest}
          // A disabled button cannot be clicked, so the callback is set here.
          onClick={() => (onCreatePullRequest as () => void)()}
        >
          +
        </button>
        <button
          type="button"
          className={styles.refresh}
          aria-label="Refresh pull requests"
          disabled={collapsed || !usable || list.fetching}
          onClick={list.refetch}
        >
          ↻
        </button>
      </div>
      {/* Always mounted, so screen readers announce the status when it appears. */}
      <p role="status" className={styles.status}>
        {actions.status}
      </p>
      {actions.error !== null && (
        <NetworkError
          message={hostingMessage(actions.error, provider)}
          onDismiss={actions.clearError}
        />
      )}
      <div id={bodyId}>{body}</div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.pr)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
      />
      {reset !== null && (
        <ConfirmDialog
          open
          title={`Reset ${reset.branch}?`}
          body={`${reset.branch} has commits that are not in #${reset.pr.number}. Resetting moves it to the pull request's head.`}
          confirmLabel="Reset"
          danger
          onConfirm={() => void actions.checkout(reset.pr, true)}
          onCancel={actions.clearResetRequest}
          fallbackFocus={headingRef}
        />
      )}
      <AccountsDialog
        open={accountsPreset !== null}
        preset={accountsPreset ?? undefined}
        onClose={() => setAccountsPreset(null)}
        fallbackFocus={headingRef}
      />
      {/* Last, so it paints above any other dialog of the panel. */}
      <CredentialDialog prompt={actions.prompt} fallbackFocus={headingRef} />
    </section>
  );
}
