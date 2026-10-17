import { useCallback, useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { ChangeKind, RepoId, StatusEntry } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { RepoError } from "../repo/RepoError";
import styles from "./ChangesPanel.module.css";
import { FileRow, type Section } from "./FileRow";
import { useFileSelection } from "./useFileSelection";
import { useStatus } from "./useStatus";
import { useWorktreeActions } from "./useWorktreeActions";

export interface ChangesPanelProps {
  repoId: RepoId;
}

interface Row {
  key: string;
  section: Section;
  entry: StatusEntry;
  kind: ChangeKind;
}

interface MenuState {
  x: number;
  y: number;
  row: Row;
}

interface ConfirmState {
  paths: string[];
  title: string;
  body: string;
  confirmLabel: string;
}

const SECTIONS: { section: Section; title: string; listLabel: string }[] = [
  { section: "conflicts", title: "Conflicts", listLabel: "Conflicts" },
  { section: "staged", title: "Staged", listLabel: "Staged changes" },
  { section: "unstaged", title: "Unstaged", listLabel: "Unstaged changes" },
];

const keyOf = (section: Section, path: string): string => `${section}:${path}`;

/** Conflicted entries go to Conflicts only; otherwise index and worktree changes are independent. */
function rowsBySection(entries: StatusEntry[]): Record<Section, Row[]> {
  const rows: Record<Section, Row[]> = { conflicts: [], staged: [], unstaged: [] };
  const add = (section: Section, entry: StatusEntry, kind: ChangeKind) =>
    rows[section].push({ key: keyOf(section, entry.path), section, entry, kind });
  for (const entry of entries) {
    if (entry.conflicted) {
      add("conflicts", entry, "conflicted");
      continue;
    }
    if (entry.index !== null) add("staged", entry, entry.index);
    if (entry.worktree !== null) add("unstaged", entry, entry.worktree);
  }
  return rows;
}

function discardCopy(paths: string[], anyUntracked: boolean): ConfirmState {
  const irreversible = "This cannot be undone.";
  if (paths.length === 1) {
    const [path] = paths;
    return anyUntracked
      ? {
          paths,
          title: `Delete untracked file ${path}?`,
          body: irreversible,
          confirmLabel: "Delete",
        }
      : {
          paths,
          title: `Discard changes to ${path}?`,
          body: irreversible,
          confirmLabel: "Discard",
        };
  }
  return {
    paths,
    title: `Discard changes to ${paths.length} files?`,
    body: anyUntracked ? `Untracked files will be deleted. ${irreversible}` : irreversible,
    confirmLabel: "Discard",
  };
}

export function ChangesPanel({ repoId }: ChangesPanelProps) {
  const idPrefix = useId();
  const { status, isLoading, error: statusError, refetch } = useStatus(repoId);
  const actions = useWorktreeActions(repoId);
  const rows = rowsBySection(status?.entries ?? []);
  const selection = useFileSelection(
    SECTIONS.flatMap(({ section }) => rows[section].map((r) => r.key)),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** The selected paths of the row's section if the row is selected, else the row alone. */
  const targets = (row: Row): string[] =>
    selection.isSelected(row.key)
      ? rows[row.section].filter((r) => selection.isSelected(r.key)).map((r) => r.entry.path)
      : [row.entry.path];

  const primary = (row: Row) =>
    row.section === "staged" ? actions.unstage(targets(row)) : actions.stage(targets(row));

  const openDiscard = (row: Row) => {
    const paths = targets(row);
    const anyUntracked = rows.unstaged.some(
      (r) => r.kind === "untracked" && paths.includes(r.entry.path),
    );
    setConfirm(discardCopy(paths, anyUntracked));
  };

  const menuItems = ({ row }: MenuState): MenuItem[] => {
    const stage: MenuItem = { id: "stage", label: "Stage", onSelect: () => primary(row) };
    let items: MenuItem[];
    if (row.section === "staged") {
      items = [{ id: "unstage", label: "Unstage", onSelect: () => primary(row) }];
    } else if (row.section === "conflicts") {
      items = [{ id: "resolve", label: "Mark resolved (stage)", onSelect: () => primary(row) }];
    } else if (row.kind === "untracked") {
      items = [
        stage,
        {
          id: "gitignore",
          label: "Add to .gitignore",
          onSelect: () => actions.addToGitignore(row.entry.path),
        },
        { id: "discard", label: "Delete…", danger: true, onSelect: () => openDiscard(row) },
      ];
    } else {
      items = [
        stage,
        { id: "discard", label: "Discard…", danger: true, onSelect: () => openDiscard(row) },
      ];
    }
    return items.map((item) => ({ ...item, disabled: actions.pending }));
  };

  const selectRow = (row: Row, mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    selection.click(row.key, { ctrl: mods.ctrlKey || mods.metaKey, shift: mods.shiftKey });
    useWorkspace.getState().select(repoId, {
      path: row.entry.path,
      scope: row.section === "staged" ? "staged" : "unstaged",
    });
  };

  const headerAction = (section: Section) => {
    if (section === "conflicts") return null;
    const [label, run] =
      section === "staged" ? ["Unstage all", actions.unstageAll] : ["Stage all", actions.stageAll];
    return (
      <button
        type="button"
        className={styles.headerAction}
        disabled={actions.pending}
        onClick={() => run()}
      >
        {label}
      </button>
    );
  };

  let body: React.ReactNode;
  if (isLoading) {
    body = <p role="status">Loading changes…</p>;
  } else if (statusError !== null) {
    body = <RepoError error={statusError} path={null} onDismiss={refetch} />;
  } else {
    const nonEmpty = SECTIONS.filter(({ section }) => rows[section].length > 0);
    body = (
      <>
        {actions.error !== null && (
          <RepoError error={actions.error} path={null} onDismiss={actions.clearError} />
        )}
        {nonEmpty.length === 0 && <p className={styles.empty}>No changes</p>}
        {nonEmpty.map(({ section, title, listLabel }) => {
          const headingId = `${idPrefix}-${section}`;
          return (
            <section key={section} className={styles.section} aria-labelledby={headingId}>
              <div className={styles.sectionHeader}>
                <h2 id={headingId} className={styles.heading}>
                  {title} ({rows[section].length})
                </h2>
                {headerAction(section)}
              </div>
              <ul aria-label={listLabel} className={styles.list}>
                {rows[section].map((row) => (
                  <FileRow
                    key={row.key}
                    entry={row.entry}
                    section={section}
                    kind={row.kind}
                    selected={selection.isSelected(row.key)}
                    disabled={actions.pending}
                    onClick={(mods) => selectRow(row, mods)}
                    onContextMenu={(x, y) => setMenu({ x, y, row })}
                    onPrimary={() => primary(row)}
                    onDiscard={section === "unstaged" ? () => openDiscard(row) : undefined}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </>
    );
  }

  return (
    <section aria-label="Changes" className={styles.root}>
      {body}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu)}
        onClose={closeMenu}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger
        onConfirm={() => {
          actions.discard((confirm as ConfirmState).paths);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
