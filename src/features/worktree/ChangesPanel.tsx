import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { SPLIT_HANDLE_WIDTH, SplitHandle } from "../../components/SplitHandle";
import { KEY_STEP } from "../../app/layout";
import type { ChangeKind, RepoId, StatusEntry } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setChangesUnstagedHeight } from "../../lib/store/settingsActions";
import { useWorkspace } from "../../lib/store/workspace";
import { useBranches } from "../branches/useBranches";
import { headName, sideLabels } from "../merge/operationCopy";
import { useIntegrationActions, type IntegrationRequest } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { RepoError } from "../repo/RepoError";
import { StashButton } from "../stash/StashButton";
import styles from "./ChangesPanel.module.css";
import { PANE_FLOOR, fitChangesPanes } from "./changesLayout";
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

/** One menu at a time: a row's context menu or the Conflicts section's Resolve all… menu. */
type MenuState = { x: number; y: number } & ({ kind: "row"; row: Row } | { kind: "resolveAll" });

interface ConfirmState {
  paths: string[];
  title: string;
  body: string;
  confirmLabel: string;
}

const SECTIONS: { section: Section; title: string; listLabel: string; emptyLabel?: string }[] = [
  { section: "conflicts", title: "Conflicts", listLabel: "Conflicts" },
  {
    section: "unstaged",
    title: "Unstaged",
    listLabel: "Unstaged changes",
    emptyLabel: "No unstaged changes",
  },
  {
    section: "staged",
    title: "Staged",
    listLabel: "Staged changes",
    emptyLabel: "No staged changes",
  },
];

/** The body wrapper's and the Conflicts content's heights; null until reported. */
interface Measured {
  body: number | null;
  conflicts: number | null;
}

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
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const conflictsRef = useRef<HTMLDivElement>(null);
  const stored = useSettings((s) => s.settings.layout.changesUnstagedHeight);
  const [measured, setMeasured] = useState<Measured>({ body: null, conflicts: null });
  const bodyShown = !isLoading && statusError === null;
  const hasConflicts = rows.conflicts.length > 0;
  const closeMenu = useCallback(() => setMenu(null), []);

  // One observer for the body wrapper and, while it is rendered, the Conflicts content. A batch
  // is applied in one functional update; entries for any other target are ignored.
  useEffect(() => {
    if (!bodyShown) return;
    const ro = new ResizeObserver((entries) => {
      const bodyEntries = entries.filter((e) => e.target === bodyRef.current);
      const conflictEntries = entries.filter((e) => e.target === conflictsRef.current);
      if (bodyEntries.length === 0 && conflictEntries.length === 0) return;
      setMeasured((prev) => ({
        body: bodyEntries.at(-1)?.contentRect.height ?? prev.body,
        conflicts: conflictEntries.at(-1)?.contentRect.height ?? prev.conflicts,
      }));
    });
    ro.observe(bodyRef.current as HTMLDivElement);
    if (hasConflicts) ro.observe(conflictsRef.current as HTMLDivElement);
    return () => {
      ro.disconnect();
      // A remounted observer reports afresh; a stale height must not size the panes meanwhile.
      setMeasured({ body: null, conflicts: null });
    };
  }, [bodyShown, hasConflicts]);

  // Until the body (and the Conflicts content, when shown) has reported, the panes keep their flex
  // fallback. Nothing here writes settings: the stored height is only clamped for display.
  const conflictsNatural = hasConflicts ? measured.conflicts : 0;
  const ready = measured.body !== null && conflictsNatural !== null;
  const container = measured.body !== null ? measured.body - SPLIT_HANDLE_WIDTH : 0;
  const heights = fitChangesPanes(container, conflictsNatural ?? 0, stored);
  const sized = (height: number): React.CSSProperties | undefined =>
    ready ? { height, flex: "none" } : undefined;

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

  const resolveAllItems = (): MenuItem[] => {
    const paths = rows.conflicts.flatMap(pathsOf);
    return [
      {
        id: "keepAll",
        label: `Keep ${sides.ours} for all files`,
        disabled: pending,
        onSelect: () => runIntegration({ action: "resolve", paths, side: "ours" }),
      },
      {
        id: "takeAll",
        label: `Take ${sides.theirs} for all files`,
        disabled: pending,
        onSelect: () => runIntegration({ action: "resolve", paths, side: "theirs" }),
      },
    ];
  };

  const rowMenuItems = (row: Row): MenuItem[] => {
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

  const menuItems = (state: MenuState): MenuItem[] =>
    state.kind === "row" ? rowMenuItems(state.row) : resolveAllItems();

  const selectRow = (row: Row, mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    selection.click(row.key, { ctrl: mods.ctrlKey || mods.metaKey, shift: mods.shiftKey });
    useWorkspace.getState().select(repoId, {
      path: row.entry.path,
      scope: row.section === "staged" ? "staged" : "unstaged",
    });
  };

  const headerAction = (section: Section) => {
    if (section === "conflicts")
      return (
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          disabled={pending}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom, kind: "resolveAll" });
          }}
        >
          Resolve all…
        </button>
      );
    const [label, run] =
      section === "staged" ? ["Unstage all", actions.unstageAll] : ["Stage all", actions.stageAll];
    return (
      <button
        type="button"
        data-variant="ghost"
        data-size="sm"
        disabled={pending || rows[section].length === 0}
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
    body = <RepoError error={statusError} path={null} variant="panel" onDismiss={refetch} />;
  } else {
    body = (
      <div ref={bodyRef} data-testid="changes-body" className={styles.body}>
        {SECTIONS.filter(({ section }) => section !== "conflicts" || hasConflicts).map(
          ({ section, title, listLabel, emptyLabel }) => {
            const headingId = `${idPrefix}-${section}`;
            const pane = section !== "conflicts";
            const content = (
              <>
                <div className={styles.sectionHeader}>
                  <h2 id={headingId} className={`gr-section-heading ${styles.heading}`}>
                    {title} ({rows[section].length})
                  </h2>
                  {headerAction(section)}
                </div>
                {rows[section].length === 0 ? (
                  <p className={styles.empty}>{emptyLabel}</p>
                ) : (
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
                        onContextMenu={(x, y) => setMenu({ x, y, kind: "row", row })}
                        onPrimary={() => primary(row)}
                        onDiscard={section === "unstaged" ? () => openDiscard(row) : undefined}
                      />
                    ))}
                  </ul>
                )}
              </>
            );
            return (
              <Fragment key={section}>
                <section
                  className={pane ? styles.pane : styles.conflicts}
                  data-pane={pane ? section : undefined}
                  aria-labelledby={headingId}
                  style={sized(heights[section])}
                >
                  {pane ? (
                    content
                  ) : (
                    // The observed wrapper keeps its natural height; the section above caps and scrolls it.
                    <div ref={conflictsRef} data-testid="conflicts-content">
                      {content}
                    </div>
                  )}
                </section>
                {section === "unstaged" && (
                  <SplitHandle
                    label="Resize Unstaged and Staged"
                    orientation="horizontal"
                    value={ready ? heights.unstaged : (stored ?? 0)}
                    min={ready ? PANE_FLOOR : 0}
                    max={ready ? heights.max : Infinity}
                    step={KEY_STEP}
                    // Nothing is stored before measuring, or when the value would not change.
                    onChange={(px) => {
                      if (ready && px !== heights.unstaged) setChangesUnstagedHeight(px);
                    }}
                    onReset={() => {
                      if (stored !== null) setChangesUnstagedHeight(null);
                    }}
                  />
                )}
              </Fragment>
            );
          },
        )}
      </div>
    );
  }

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      data-focus-target
      aria-label="Changes"
      className={styles.root}
    >
      {/* Outside the body branches: a failed background refetch keeps the data, the button and its open dialog. */}
      {status !== undefined && (
        <div className={styles.toolbar}>
          <StashButton
            repoId={repoId}
            variant="text"
            disabled={pending || statusError !== null}
            fallbackFocus={rootRef}
          />
        </div>
      )}
      {bodyShown && panelError !== null && (
        // Outside the measured body, so the panes are sized to the space left below it.
        <div className={styles.error}>
          <RepoError error={panelError} path={null} variant="panel" onDismiss={clearErrors} />
        </div>
      )}
      {body}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu)}
        onClose={closeMenu}
        fallbackFocus={rootRef}
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
        fallbackFocus={rootRef}
      />
    </section>
  );
}
