import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { SectionHead } from "../../components/SectionHead";
import type { AppError, LinkedWorktree, RepoId } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setWorktreesCollapsed } from "../../lib/store/settingsActions";
import { useWorkspace } from "../../lib/store/workspace";
import { filterWorktrees, isFiltering } from "../branches/branchFilter";
import { sectionCountLabel } from "../branches/sectionCountLabel";
import { toastError } from "../remotes/toastError";
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

/** The remove confirm on screen: the first step, or the force step for a dirty worktree. */
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
  const query = useWorkspace((s) => s.refsFilter[repoId] ?? "");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [adding, setAdding] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  const filtering = isFiltering(query);
  const expanded = filtering || !collapsed;
  const shown = list ? filterWorktrees(list, query) : [];
  const bare = list !== undefined && list.length === 0;
  const stale = (list ?? []).filter(isStale).map((w) => w.path);

  // A load failure with nothing to show toasts once per error object, so a failed Retry (a new
  // error) toasts again. `refetch` is read through an effect event, not listed as a dependency.
  const toastLoadFailure = useEffectEvent((error: AppError) =>
    toastError(
      { ...error, message: `Couldn't load worktrees: ${error.message}` },
      { retry: refetch },
    ),
  );
  const loadFailed = list === undefined && listError !== null;
  useEffect(() => {
    if (loadFailed) toastLoadFailure(listError);
  }, [loadFailed, listError]);

  /** Toasts an action's resolved failure; null (success) shows nothing. */
  const report = (error: AppError | null) => {
    if (error !== null) toastError(error);
  };

  const openPath = (path: string) => void opener.open(path).then(report);

  const open = (w: LinkedWorktree) => {
    if (openTitle(w) === undefined) openPath(w.path);
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

  // The final confirmation: only this closes tabs. A dirty worktree (changed since the check)
  // reopens the force step; any other failure toasts and the settle invalidation refreshes.
  const remove = async (c: Confirm) => {
    setConfirm(null);
    const e = await actions.remove(c.path, c.force);
    if (e?.kind === "worktreeDirty") setConfirm({ path: c.path, force: true });
    else report(e);
  };

  // The first step checks dirtiness before anything closes, so cancelling the force step keeps
  // the tab and its draft. A check failure toasts and stops.
  const confirmFirst = async (path: string) => {
    setConfirm(null);
    const dirty = await actions.checkDirty(path);
    if (dirty === false) return remove({ path, force: false });
    if (dirty === true) setConfirm({ path, force: true });
    else report(dirty);
  };

  const prune = () => void actions.prune(stale).then(report);

  let body: React.ReactNode;
  if (!expanded) {
    body = null;
  } else if (loadFailed) {
    body = <p className={styles.empty}>Couldn't load worktrees</p>;
  } else if (list === undefined) {
    body = <p role="status">Loading worktrees…</p>;
  } else if (bare) {
    body = <p className={styles.empty}>Not available for bare repositories</p>;
  } else if (shown.length === 0) {
    body = <p className={styles.empty}>No matches</p>;
  } else {
    body = (
      <ul aria-label="Worktree list" className={styles.list}>
        {shown.map((w) => (
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
      <SectionHead>
        <div className={`gr-section-header ${styles.header}`}>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            data-focus-target
            className={`gr-section-heading ${styles.heading}`}
          >
            <button
              type="button"
              className="gr-section-toggle"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setWorktreesCollapsed(!collapsed)}
            >
              {sectionCountLabel("Worktrees", shown.length, list?.length, filtering)}
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
                Prune
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
      </SectionHead>
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
          onConfirm={() => void confirmFirst(confirm.path)}
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
        onAdded={openPath}
        fallbackFocus={headingRef}
      />
    </section>
  );
}
