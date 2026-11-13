import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { SectionHead } from "../../components/SectionHead";
import type { AppError, RepoId, StashEntry } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { filterStashes, isFiltering } from "../branches/branchFilter";
import { sectionCountLabel } from "../branches/sectionCountLabel";
import { useNow } from "../graph/useNow";
import { useOperationState } from "../merge/useOperationState";
import { toastError } from "../remotes/toastError";
import { useStatus } from "../worktree/useStatus";
import { StashButton } from "./StashButton";
import { StashRow } from "./StashRow";
import styles from "./StashesPanel.module.css";
import { displayError, stashRef } from "./stashCopy";
import { applyGate } from "./stashGate";
import { useStashActions } from "./useStashActions";
import { useStashes } from "./useStashes";

export interface StashesPanelProps {
  repoId: RepoId;
}

interface MenuState {
  x: number;
  y: number;
  entry: StashEntry;
}

export function StashesPanel({ repoId }: StashesPanelProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { stashes, error: listError, refetch } = useStashes(repoId);
  const actions = useStashActions(repoId);
  const { status } = useStatus(repoId);
  const { state } = useOperationState(repoId);
  const now = useNow();
  const query = useWorkspace((s) => s.refsFilter[repoId] ?? "");
  const selected = useWorkspace((s) => s.selectedStash[repoId] ?? null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<StashEntry | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const apply = applyGate(status, state);
  const filtering = isFiltering(query);
  const shown = stashes ? filterStashes(stashes, query) : [];

  // A load failure with nothing to show toasts once per error object, so a failed Retry (a new
  // error) toasts again. `refetch` is read through an effect event, not listed as a dependency.
  const toastLoadFailure = useEffectEvent((error: AppError) =>
    toastError(
      { ...error, message: `Couldn't load stashes: ${error.message}` },
      { retry: refetch },
    ),
  );
  const loadFailed = stashes === undefined && listError !== null;
  useEffect(() => {
    if (loadFailed) toastLoadFailure(listError);
  }, [loadFailed, listError]);

  // The failure is toasted here, from the resolved result; a notice the action raised was already
  // toasted by the hook.
  const run = (action: () => Promise<AppError | null>) => {
    void action().then((e) => {
      if (e !== null) toastError(displayError(e));
    });
  };

  const menuItems = (entry: StashEntry): MenuItem[] => [
    {
      id: "apply",
      label: "Apply",
      disabled: actions.pending || apply.disabled,
      title: apply.title,
      onSelect: () => run(() => actions.apply(entry)),
    },
    {
      id: "pop",
      label: "Pop",
      disabled: actions.pending || apply.disabled,
      title: apply.title,
      onSelect: () => run(() => actions.pop(entry).then((r) => r.error)),
    },
    {
      id: "drop",
      label: "Drop…",
      danger: true,
      disabled: actions.pending,
      onSelect: () => setConfirm(entry),
    },
  ];

  // Closes at once, as the Changes discard confirm does; the drop's pending state disables the actions.
  const confirmDrop = (entry: StashEntry) => {
    setConfirm(null);
    run(() => actions.drop(entry));
  };

  let body: React.ReactNode;
  if (loadFailed) {
    body = <p className={styles.empty}>Couldn't load stashes</p>;
  } else if (stashes === undefined) {
    body = <p role="status">Loading stashes…</p>;
  } else if (stashes.length === 0) {
    body = <p className={styles.empty}>No stashes</p>;
  } else if (shown.length === 0) {
    body = <p className={styles.empty}>No matches</p>;
  } else {
    body = (
      <ul aria-label="Stash list" className={styles.list}>
        {shown.map((entry) => (
          <StashRow
            key={entry.oid}
            entry={entry}
            selected={entry.oid === selected}
            now={now}
            onSelect={() => useWorkspace.getState().selectStash(repoId, entry.oid)}
            onContextMenu={(x, y) => setMenu({ x, y, entry })}
          />
        ))}
      </ul>
    );
  }

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
            {sectionCountLabel("Stashes", shown.length, stashes?.length, filtering)}
          </h2>
          <StashButton
            repoId={repoId}
            variant="icon"
            className={styles.add}
            disabled={actions.pending}
            fallbackFocus={headingRef}
          />
        </div>
      </SectionHead>
      {body}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.entry)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
      />
      {confirm !== null && (
        <ConfirmDialog
          open
          title={`Drop ${stashRef(confirm.index)}?`}
          body="This can't be undone."
          confirmLabel="Drop"
          danger
          onConfirm={() => confirmDrop(confirm)}
          onCancel={() => setConfirm(null)}
          fallbackFocus={headingRef}
        />
      )}
    </section>
  );
}
