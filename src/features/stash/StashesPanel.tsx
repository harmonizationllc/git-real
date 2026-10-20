import { useCallback, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { AppError, RepoId, StashEntry } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { useNow } from "../graph/useNow";
import { useOperationState } from "../merge/useOperationState";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { StashButton } from "./StashButton";
import { StashFeedback } from "./StashFeedback";
import { StashRow } from "./StashRow";
import styles from "./StashesPanel.module.css";
import { stashRef } from "./stashCopy";
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
  const selected = useWorkspace((s) => s.selectedStash[repoId] ?? null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<StashEntry | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const apply = applyGate(status, state);

  // A newer result must not hide behind an older, undismissed error.
  const run = (action: () => Promise<AppError | null>) => {
    actions.clearError();
    void action();
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
      onSelect: () => run(() => actions.pop(entry)),
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
  if (listError !== null) {
    body = <RepoError error={listError} path={null} onRetry={refetch} onDismiss={refetch} />;
  } else if (stashes === undefined) {
    body = <p role="status">Loading stashes…</p>;
  } else if (stashes.length === 0) {
    body = <p className={styles.empty}>No stashes</p>;
  } else {
    body = (
      <ul aria-label="Stash list" className={styles.list}>
        {stashes.map((entry) => (
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
      <div className={styles.header}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
          {`Stashes (${stashes?.length ?? 0})`}
        </h2>
        <StashButton
          repoId={repoId}
          variant="icon"
          className={styles.add}
          disabled={actions.pending}
          fallbackFocus={headingRef}
        />
      </div>
      <StashFeedback actions={actions} />
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
