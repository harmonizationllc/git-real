import { useCallback, useId, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { Issue, RepoId } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setIssuesCollapsed } from "../../lib/store/settingsActions";
import { NetworkError } from "../remotes/NetworkError";
import { AccountsDialog } from "./AccountsDialog";
import type { AccountsPreset } from "./AccountsDialog";
import {
  ISSUES_OFF_TEXT,
  PROVIDER_LABEL,
  RECONNECT_TEXT,
  hostingMessage,
  issueCountLabel,
} from "./hostingCopy";
import { IssueRow } from "./IssueRow";
import styles from "./IssuesPanel.module.css";
import { useIssues } from "./useIssues";
import { useLinkActions } from "./useLinkActions";
import { useRepoContext } from "./useRepoContext";
import { issuesAllowed, useRepoInfo } from "./useRepoInfo";

interface MenuState {
  x: number;
  y: number;
  issue: Issue;
}

/** The open issues of the hosted repository behind `origin`; absent for any other origin. */
export function IssuesPanel({ repoId }: { repoId: RepoId }) {
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { context } = useRepoContext(repoId);
  const collapsed = useSettings((s) => s.settings.layout.issuesCollapsed);
  const account = context?.account ?? null;
  const usable = account !== null && !account.needsReconnect;
  const repoInfo = useRepoInfo(repoId, !collapsed && usable);
  const info = repoInfo.info;
  // No issues call before the repository info answers; a failed info falls back to asking
  // (unless it was the token or the rate limit), so the list's own error still shows.
  const allowed = issuesAllowed(info, repoInfo.error);
  const list = useIssues(repoId, "", !collapsed && usable && allowed);
  const links = useLinkActions();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [accountsPreset, setAccountsPreset] = useState<AccountsPreset | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The row button that opened the menu, which the menu ignores so a second click toggles it.
  const menuButton = useRef<HTMLButtonElement>(null);

  // Every hook runs above: the section exists only for a hosted origin.
  if (!context) return null;

  const { repo } = context;
  const provider = repo.provider;
  const openAccounts = () => setAccountsPreset({ provider, host: repo.host });
  const reconnect =
    account?.needsReconnect === true ||
    repoInfo.error?.kind === "hostingAuth" ||
    list.error?.kind === "hostingAuth";
  const issues = list.issues;

  const refresh = () => {
    repoInfo.refetch();
    if (allowed) list.refetch();
  };

  const menuItems = (issue: Issue): MenuItem[] => [
    { id: "open", label: "Open in browser", onSelect: () => links.open(issue.webUrl) },
    { id: "copy", label: "Copy link", onSelect: () => links.copyLink(issue.webUrl) },
  ];

  // The heading shows the count only while the body shows the loaded list (or its empty state).
  let listed = false;
  let body: React.ReactNode;
  if (collapsed) {
    body = null;
  } else if (account === null) {
    body = (
      <div className={styles.notice}>
        <p className={styles.empty}>
          Connect your {PROVIDER_LABEL[provider]} account to see issues
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
  } else if (info?.issuesEnabled === false) {
    body = <p className={styles.empty}>{ISSUES_OFF_TEXT}</p>;
  } else if (info === undefined && repoInfo.error !== null && !allowed) {
    // The repository info failed in a way a listing would only repeat, so it stands in for it.
    body = (
      <NetworkError
        message={hostingMessage(repoInfo.error, provider)}
        onDismiss={repoInfo.refetch}
      />
    );
  } else if (list.error !== null && issues === undefined) {
    // Nothing loaded yet: the error stands in for the list. A failed Show more keeps the list.
    body = <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />;
  } else if (issues === undefined) {
    body = <p role="status">Loading issues…</p>;
  } else if (issues.length === 0) {
    listed = true;
    body = <p className={styles.empty}>No open issues</p>;
  } else {
    listed = true;
    body = (
      <>
        <ul aria-label="Issue list" className={styles.list}>
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              onOpen={() => links.open(issue.webUrl)}
              onContextMenu={(x, y) =>
                setMenu((m) => (m?.issue.number === issue.number ? null : { x, y, issue }))
              }
              buttonRef={menu?.issue.number === issue.number ? menuButton : undefined}
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

  return (
    <section aria-labelledby={headingId} className={styles.root}>
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
            onClick={() => setIssuesCollapsed(!collapsed)}
          >
            {issueCountLabel(listed ? (issues as Issue[]).length : null, list.hasMore)}
          </button>
        </h2>
        <button
          type="button"
          className={styles.refresh}
          aria-label="Refresh issues"
          disabled={collapsed || !usable || list.fetching}
          onClick={refresh}
        >
          ↻
        </button>
      </div>
      {links.error !== null && (
        <NetworkError
          message={hostingMessage(links.error, provider)}
          onDismiss={links.clearError}
        />
      )}
      <div id={bodyId}>{body}</div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.issue)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
        ignore={menuButton}
      />
      <AccountsDialog
        open={accountsPreset !== null}
        preset={accountsPreset ?? undefined}
        onClose={() => setAccountsPreset(null)}
        fallbackFocus={headingRef}
      />
    </section>
  );
}
