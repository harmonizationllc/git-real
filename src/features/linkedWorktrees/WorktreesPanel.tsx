import { useCallback, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { LinkedWorktree, RepoId } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setWorktreesCollapsed } from "../../lib/store/settingsActions";
import { RepoError } from "../repo/RepoError";
import { useOpenRepo } from "../repo/useOpenRepo";
import { AddWorktreeDialog } from "./AddWorktreeDialog";
import { WorktreeRow } from "./WorktreeRow";
import styles from "./WorktreesPanel.module.css";
import { useLinkedWorktreeActions } from "./useLinkedWorktreeActions";
import { useLinkedWorktrees } from "./useLinkedWorktrees";
import { openTitle, removeTitle } from "./worktreeCopy";
import { folderName } from "./worktreePath";

interface MenuState {
  x: number;
  y: number;
  worktree: LinkedWorktree;
}

/** The remove confirm on screen: the first step, or the force step after `worktreeDirty`. */
interface Confirm {
  path: string;
  force: boolean;
}

const ADD_LABEL = "Add worktree…";
const PRUNE_LABEL = "Prune stale worktrees";

/** A missing worktree that prune clears; a locked one is kept. */
const isStale = (w: LinkedWorktree) => w.missing && w.locked === null;

export function WorktreesPanel({ repoId }: { repoId: RepoId }): React.JSX.Element {
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { list, error: listError, refetch } = useLinkedWorktrees(repoId);
  const actions = useLinkedWorktreeActions(repoId);
  const opener = useOpenRepo();
  const collapsed = useSettings((s) => s.settings.layout.worktreesCollapsed);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [adding, setAdding] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  const bare = list !== undefined && list.length === 0;
  const stale = (list ?? []).filter(isStale).map((w) => w.path);

  const open = (w: LinkedWorktree) => {
    if (openTitle(w) === undefined) void opener.open(w.path);
  };

  const menuItems = (w: LinkedWorktree): MenuItem[] => [
    {
      id: "open",
      label: "Open",
      disabled: openTitle(w) !== undefined,
      title: openTitle(w),
      onSelect: () => open(w),
    },
    {
      id: "remove",
      label: "Remove…",
      danger: true,
      disabled: removeTitle(w) !== undefined || actions.pending,
      title: removeTitle(w),
      onSelect: () => setConfirm({ path: w.path, force: false }),
    },
  ];

  // Closes at once, as the tag delete confirm does; a dirty worktree reopens it as the force step.
  // Any other failure shows inline; the action's settle invalidation refreshes the list.
  const remove = async (c: Confirm) => {
    setConfirm(null);
    opener.clearError();
    const e = await actions.remove(c.path, c.force);
    if (e === null || e.kind !== "worktreeDirty") return;
    actions.clearError();
    setConfirm({ path: c.path, force: true });
  };

  const prune = () => {
    opener.clearError();
    void actions.prune(stale);
  };

  let body: React.ReactNode;
  if (collapsed) {
    body = null;
  } else if (listError !== null) {
    body = <RepoError error={listError} path={null} onRetry={refetch} onDismiss={refetch} />;
  } else if (list === undefined) {
    body = <p role="status">Loading worktrees…</p>;
  } else if (bare) {
    body = <p className={styles.empty}>Not available for bare repositories</p>;
  } else {
    body = (
      <ul aria-label="Worktree list" className={styles.list}>
        {list.map((w) => (
          <WorktreeRow
            key={w.path}
            worktree={w}
            onOpen={() => open(w)}
            onContextMenu={(x, y) => setMenu({ x, y, worktree: w })}
          />
        ))}
      </ul>
    );
  }

  const folder = confirm === null ? "" : folderName(confirm.path);

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
            onClick={() => setWorktreesCollapsed(!collapsed)}
          >
            {`Worktrees (${list?.length ?? 0})`}
          </button>
        </h2>
        {!bare && (
          <>
            <button
              type="button"
              className={styles.action}
              aria-label={PRUNE_LABEL}
              title={stale.length === 0 ? "No stale worktrees" : undefined}
              disabled={stale.length === 0 || actions.pending}
              onClick={prune}
            >
              ⌫
            </button>
            <button
              type="button"
              className={styles.action}
              aria-label={ADD_LABEL}
              title={ADD_LABEL}
              disabled={actions.pending}
              onClick={() => setAdding(true)}
            >
              +
            </button>
          </>
        )}
      </div>
      {actions.error && (
        <RepoError
          error={actions.error}
          path={null}
          variant="panel"
          onDismiss={actions.clearError}
        />
      )}
      {opener.error && (
        <RepoError error={opener.error} path={null} variant="panel" onDismiss={opener.clearError} />
      )}
      <div id={bodyId}>{body}</div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.worktree)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
      />
      {confirm !== null && !confirm.force && (
        <ConfirmDialog
          open
          title={`Remove worktree ${folder}?`}
          body="The folder and its contents are deleted. The branch is kept."
          confirmLabel="Remove"
          danger
          onConfirm={() => void remove(confirm)}
          onCancel={() => setConfirm(null)}
          fallbackFocus={headingRef}
        />
      )}
      {confirm !== null && confirm.force && (
        <ConfirmDialog
          open
          title={`${folder} has uncommitted changes`}
          body="Removing it discards them. This can't be undone."
          confirmLabel="Remove anyway"
          danger
          onConfirm={() => void remove(confirm)}
          onCancel={() => setConfirm(null)}
          fallbackFocus={headingRef}
        />
      )}
      <AddWorktreeDialog
        repoId={repoId}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(path) => void opener.open(path)}
        fallbackFocus={headingRef}
      />
    </section>
  );
}
