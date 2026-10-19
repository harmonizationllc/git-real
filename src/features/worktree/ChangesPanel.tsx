import { useCallback, useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { ChangeKind, RepoId, StatusEntry } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { useBranches } from "../branches/useBranches";
import { headName, sideLabels } from "../merge/operationCopy";
import { useIntegrationActions, type IntegrationRequest } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
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

/** A row's paths: a rename is one change made of its new path and then its old path. */
const pathsOf = (row: Row): string[] =>
  row.kind === "renamed" && row.entry.oldPath !== null
    ? [row.entry.path, row.entry.oldPath]
    : [row.entry.path];

function discardCopy(targetRows: Row[]): ConfirmState {
  const irreversible = "This cannot be undone.";
  const paths = targetRows.flatMap(pathsOf);
  if (targetRows.length === 1) {
    const [{ entry, kind }] = targetRows;
    if (kind === "untracked") {
      const what = entry.path.endsWith("/") ? "folder" : "file";
      return {
        paths,
        title: `Delete untracked ${what} ${entry.path}?`,
        body: irreversible,
        confirmLabel: "Delete",
      };
    }
    return {
      paths,
      title: `Discard changes to ${entry.path}?`,
      body:
        kind === "renamed"
          ? `${irreversible} The new file ${entry.path} will be deleted.`
          : irreversible,
      confirmLabel: "Discard",
    };
  }
  const anyUntracked = targetRows.some((r) => r.kind === "untracked");
  return {
    paths,
    title: `Discard changes to ${targetRows.length} files?`,
    body: anyUntracked ? `Untracked files will be deleted. ${irreversible}` : irreversible,
    confirmLabel: "Discard",
  };
}

export function ChangesPanel({ repoId }: ChangesPanelProps) {
  const idPrefix = useId();
  const { status, isLoading, error: statusError, refetch } = useStatus(repoId);
  const actions = useWorktreeActions(repoId);
  const { state } = useOperationState(repoId);
  const { branches } = useBranches(repoId);
  const integration = useIntegrationActions(repoId);
  const sides = sideLabels(state, headName(branches?.head));
  const pending = actions.pending || integration.pending;
  const panelError = actions.error ?? integration.error;
  const rows = rowsBySection(status?.entries ?? []);
  const selection = useFileSelection(
    SECTIONS.flatMap(({ section }) => rows[section].map((r) => r.key)),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const clearErrors = () => {
    actions.clearError();
    integration.clearError();
  };

  // A newer integration failure must not hide behind an older, undismissed panel error.
  const runIntegration = (req: IntegrationRequest) => {
    clearErrors();
    void integration.run(req);
  };

  /** The selected rows of the row's section if the row is selected, else the row alone. */
  const targetRows = (row: Row): Row[] =>
    selection.isSelected(row.key)
      ? rows[row.section].filter((r) => selection.isSelected(r.key))
      : [row];

  const targets = (row: Row): string[] => targetRows(row).flatMap(pathsOf);

  const primary = (row: Row) =>
    row.section === "staged" ? actions.unstage(targets(row)) : actions.stage(targets(row));

  const openDiscard = (row: Row) => setConfirm(discardCopy(targetRows(row)));

  const menuItems = ({ row }: MenuState): MenuItem[] => {
    const stage: MenuItem = { id: "stage", label: "Stage", onSelect: () => primary(row) };
    let items: MenuItem[];
    if (row.section === "staged") {
      items = [{ id: "unstage", label: "Unstage", onSelect: () => primary(row) }];
    } else if (row.section === "conflicts") {
      items = [
        {
          id: "keepOurs",
          label: `Keep ${sides.ours}`,
          onSelect: () => runIntegration({ action: "resolve", paths: targets(row), side: "ours" }),
        },
        {
          id: "takeTheirs",
          label: `Take ${sides.theirs}`,
          onSelect: () =>
            runIntegration({ action: "resolve", paths: targets(row), side: "theirs" }),
        },
        { id: "resolve", label: "Mark resolved (stage)", onSelect: () => primary(row) },
      ];
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
    // File history only reads, so it stays enabled while an action is pending.
    return [
      ...items.map((item) => ({ ...item, disabled: pending })),
      {
        id: "history",
        label: "File history",
        onSelect: () => useWorkspace.getState().showHistory(repoId, row.entry.path),
      },
    ];
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
        disabled={pending}
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
        {panelError !== null && (
          <RepoError error={panelError} path={null} onDismiss={clearErrors} />
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
                    disabled={pending}
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
