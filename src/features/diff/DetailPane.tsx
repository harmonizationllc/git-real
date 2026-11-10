import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { DiffMode, FileDiff, HunkAction, HunkSelection, RepoId } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setDiffMode, setIgnoreWhitespace } from "../../lib/store/settingsActions";
import { useShell } from "../../lib/store/shell";
import { useWorkspace, type SelectedFile } from "../../lib/store/workspace";
import { BlameView } from "../history/BlameView";
import { ConflictEditor } from "../merge/editor/ConflictEditor";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { useWorktreeActions, type UseWorktreeActions } from "../worktree/useWorktreeActions";
import { BinaryPlaceholder } from "./BinaryPlaceholder";
import { DiffToolbar } from "./DiffToolbar";
import { ChangeRuler } from "./ChangeRuler";
import { DiffViewer, type DiffViewerHandle } from "./DiffViewer";
import { FileHeader } from "./FileHeader";
import { ImageDiff } from "./ImageDiff";
import { isDecoded } from "./model/encoding";
import type { HighlightMap } from "./model/highlight";
import { isImagePath } from "./model/images";
import { FULL_DIFF_LINES, totalLines } from "./model/limits";
import { buildRows, type DiffRow } from "./model/rows";
import { LABELS, NOTHING_REASON, revertBody } from "./model/menu";
import { commitOf, isReadOnly, scopeId } from "./model/scope";
import { selectionRequest, type MenuTarget } from "./model/selection";
import { useChangeNavigation } from "./useChangeNavigation";
import { useFileDiff } from "./useFileDiff";
import { useHighlight } from "./useHighlight";
import styles from "./DetailPane.module.css";

export const WHITESPACE_REASON =
  "Turn off “Hide whitespace changes” to stage, unstage or discard hunks";
export const DECODED_REASON =
  "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel";
export const PENDING_REASON = "Applying changes…";

/** The selected file's diff or blame; renders nothing without a selection, so RepoPane decides what shows. */
export function DetailPane({ repoId }: { repoId: RepoId }) {
  const file = useWorkspace((s) => s.selected[repoId] ?? null);
  const { status } = useStatus(repoId);
  if (file === null) return null;
  // A conflicted path's working-tree side is edited in place; its staged side keeps the diff.
  const entry =
    file.scope === "unstaged"
      ? status?.entries.find((e) => e.path === file.path && e.conflicted)
      : undefined;
  if (entry !== undefined) {
    // Keyed by kind too, so a refetch that turns one kind into another starts the right view afresh.
    return (
      <ConflictEditor
        key={`conflict:${file.path}:${entry.conflict ?? "markers"}`}
        repoId={repoId}
        path={file.path}
        conflict={entry.conflict}
      />
    );
  }
  // Keyed so line cap, menu, dialog, action error and scroll offset never leak to another file.
  return <FileDetail key={`${scopeId(file.scope)}:${file.path}`} repoId={repoId} file={file} />;
}

const STASH_BLAME_REASON = "Blame is not available for stashed files";

function FileDetail({ repoId, file }: { repoId: RepoId; file: SelectedFile }) {
  const storedView = useWorkspace((s) => s.centreView[repoId] ?? "diff");
  // A stash file always shows its diff; the stored view is kept for the next file.
  const blameable = file.source !== "stash";
  const view = blameable ? storedView : "diff";
  const setView = useWorkspace((s) => s.setCentreView);
  const showHistory = useWorkspace((s) => s.showHistory);
  const mode = useSettings((s) => s.settings.diff.mode);
  const ignoreWhitespace = useSettings((s) => s.settings.diff.ignoreWhitespace);
  const [maxLines, setMaxLines] = useState<number | null>(null);
  // Blame needs no diff; a null file disables the query.
  const { diff, error, loading, noChanges, refetch } = useFileDiff(
    repoId,
    view === "blame" ? null : file,
    ignoreWhitespace,
    maxLines,
  );
  // Every hook runs before the first return: toggling the view keeps this component mounted.
  const highlight = useHighlight(diff);
  const actions = useWorktreeActions(repoId);
  const readOnly = isReadOnly(file.scope);
  const close = () => useWorkspace.getState().select(repoId, null);
  const header = (oldPath: string | null = null) => (
    <FileHeader
      path={file.path}
      oldPath={oldPath}
      view={view}
      onViewChange={(v) => setView(repoId, v)}
      onHistory={() => showHistory(repoId, file.path)}
      onClose={close}
      blameDisabledReason={blameable ? undefined : STASH_BLAME_REASON}
      repoId={repoId}
      scope={file.scope}
      isStash={file.source === "stash"}
    />
  );

  if (view === "blame") {
    return (
      <div className={styles.root}>
        {header()}
        <BlameView repoId={repoId} path={file.path} oid={commitOf(file.scope)} />
      </div>
    );
  }
  if (noChanges) {
    // Hiding whitespace can empty a diff; keep the only control that caused it reachable.
    return (
      <div className={styles.root}>
        {header()}
        <Empty>
          <p className={styles.message}>
            {readOnly ? `No changes in ${file.path}` : `No ${file.scope} changes in ${file.path}`}
          </p>
          {ignoreWhitespace && (
            <label className={styles.option}>
              <input type="checkbox" checked onChange={() => setIgnoreWhitespace(false)} />
              Hide whitespace changes
            </label>
          )}
        </Empty>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.root}>
        {header()}
        <RepoError error={error} path={null} onRetry={refetch} onDismiss={close} />
      </div>
    );
  }
  if (loading || !diff) {
    return (
      <div className={styles.root}>
        {header()}
        <Empty>
          <span role="status">Loading diff…</span>
        </Empty>
      </div>
    );
  }
  if (diff.isBinary) {
    return (
      <div className={styles.root}>
        {header(diff.oldPath)}
        {isImagePath(diff.path) ? (
          <ImageDiff repoId={repoId} diff={diff} />
        ) : (
          <BinaryPlaceholder diff={diff} />
        )}
      </div>
    );
  }

  // Mounted only while a text diff shows, so a load, an error or blame unmounts the viewer,
  // withdraws the navigation and drops any open menu or revert.
  return (
    <TextDiff
      repoId={repoId}
      diff={diff}
      header={header(diff.oldPath)}
      mode={mode}
      highlight={highlight}
      ignoreWhitespace={ignoreWhitespace}
      editable={readOnly ? null : (file.scope as "staged" | "unstaged")}
      actions={actions}
      onLoadFull={() => setMaxLines(FULL_DIFF_LINES)}
    />
  );
}

/** An open right-click menu at the pointer. */
interface OpenMenu {
  x: number;
  y: number;
  target: MenuTarget;
}

/** A revert awaiting confirmation, with the dialog copy it was chosen with. */
interface PendingRevert {
  selection: HunkSelection;
  body: string;
}

interface TextDiffProps {
  repoId: RepoId;
  diff: FileDiff;
  header: React.ReactNode;
  mode: DiffMode;
  highlight: HighlightMap | null;
  ignoreWhitespace: boolean;
  /** The working-tree side shown; null for a commit or stash diff, which has no menu. */
  editable: "staged" | "unstaged" | null;
  actions: UseWorktreeActions;
  onLoadFull(): void;
}

/** A loaded text diff: toolbar, viewer, right-click menu and revert dialog. */
function TextDiff({
  repoId,
  diff,
  header,
  mode,
  highlight,
  ignoreWhitespace,
  editable,
  actions,
  onLoadFull,
}: TextDiffProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DiffViewerHandle>(null);
  const rows = useMemo(() => buildRows(diff, mode), [diff, mode]);
  const nav = useChangeNavigation(diff, rows, viewerRef);
  // Bound to the rows they were opened on: a refetch or mode switch may renumber the rows, so a
  // stale menu or revert is dropped while rendering and never applies to other lines.
  const [ui, setUi] = useState<{
    rows: DiffRow[];
    menu: OpenMenu | null;
    pending: PendingRevert | null;
  }>({ rows, menu: null, pending: null });
  let { menu, pending } = ui;
  if (ui.rows !== rows) {
    menu = pending = null;
    setUi({ rows, menu, pending });
  }
  const viewerShown = rows.length > 0 && !(diff.truncated && nav.count === 0);
  // The published slot stays the same object while the viewer shows and calls the latest
  // closures, so stepping never republishes (and never passes through null).
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  useEffect(() => {
    if (!viewerShown) return;
    const { publishDiffNavigation } = useShell.getState();
    publishDiffNavigation({
      repoId,
      next: () => navRef.current.next(),
      prev: () => navRef.current.prev(),
    });
    return () => publishDiffNavigation(null);
  }, [viewerShown, repoId]);

  const reason = ignoreWhitespace
    ? WHITESPACE_REASON
    : isDecoded(diff)
      ? DECODED_REASON
      : actions.pending
        ? PENDING_REASON
        : undefined;
  // The selection requests are computed once per opened menu, not on every render while it is open.
  const target = menu?.target ?? null;
  const requests = useMemo(() => {
    if (target === null) return [];
    const menuActions: readonly HunkAction[] =
      editable === "staged" ? ["unstage"] : ["discard", "stage"];
    return menuActions.map((action) => ({
      action,
      request: selectionRequest(diff, rows, target, action),
    }));
  }, [target, diff, rows, editable]);
  const items: MenuItem[] =
    target === null
      ? []
      : requests.map(({ action, request }) => {
          const title = reason ?? (request === null ? NOTHING_REASON[target.kind] : undefined);
          return {
            id: action,
            label: LABELS[action][target.kind],
            danger: action === "discard",
            disabled: title !== undefined,
            title,
            onSelect: () => {
              // A disabled item never fires, so an enabled one always has its request.
              const selection = request as HunkSelection;
              if (action === "discard") {
                const body = revertBody(diff, rows, target, selection);
                setUi((s) => ({ ...s, pending: { selection, body } }));
              } else {
                actions.applyHunk(diff.path, action, selection);
              }
            },
          };
        });

  let body: React.ReactNode;
  if (rows.length === 0) {
    body = (
      <Empty>
        {encodingChanged(diff) ? "Only the encoding changed" : "No line changes in this file"}
      </Empty>
    );
  } else if (!viewerShown) {
    // Truncated before its first change: say so where the change would show.
    body = (
      <Empty>
        <p className={styles.message}>{`The first ${totalLines(diff)} lines are unchanged`}</p>
        <button type="button" data-variant="ghost" data-size="sm" onClick={onLoadFull}>
          Load full diff
        </button>
      </Empty>
    );
  } else {
    body = (
      <DiffViewer
        ref={viewerRef}
        diff={diff}
        rows={rows}
        mode={mode}
        highlight={highlight}
        onMounted={() => nav.goTo(0)}
        onUserScroll={nav.onUserScroll}
        aside={
          <ChangeRuler
            blocks={nav.blocks}
            rowCount={rows.length}
            current={nav.current}
            onSelect={nav.goTo}
          />
        }
        {...(editable && {
          // A second right-click replaces the open menu.
          onContextMenu: (target: MenuTarget, x: number, y: number) =>
            setUi((s) => ({ ...s, menu: { x, y, target } })),
        })}
      />
    );
  }

  return (
    <div ref={rootRef} tabIndex={-1} data-focus-target className={styles.root}>
      {header}
      <DiffToolbar
        diff={diff}
        mode={mode}
        ignoreWhitespace={ignoreWhitespace}
        onModeChange={setDiffMode}
        onIgnoreWhitespaceChange={setIgnoreWhitespace}
        onLoadFull={onLoadFull}
        navigation={nav}
      />
      {actions.error && (
        <RepoError error={actions.error} path={null} onDismiss={actions.clearError} />
      )}
      {body}
      {editable && (
        <>
          <ContextMenu
            open={menu !== null}
            x={menu?.x ?? 0}
            y={menu?.y ?? 0}
            items={items}
            onClose={() => setUi((s) => ({ ...s, menu: null }))}
            fallbackFocus={rootRef}
          />
          <ConfirmDialog
            open={pending !== null}
            title="Revert changes"
            danger
            confirmLabel="Revert"
            body={pending?.body ?? ""}
            onCancel={() => setUi((s) => ({ ...s, pending: null }))}
            fallbackFocus={rootRef}
            onConfirm={() => {
              actions.applyHunk(diff.path, "discard", (pending as PendingRevert).selection);
              setUi((s) => ({ ...s, pending: null }));
            }}
          />
        </>
      )}
    </div>
  );
}

/** Both sides were decoded, from different encodings; anything else changed no lines. */
function encodingChanged({ oldEncoding, newEncoding }: FileDiff): boolean {
  return oldEncoding !== null && newEncoding !== null && oldEncoding !== newEncoding;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
