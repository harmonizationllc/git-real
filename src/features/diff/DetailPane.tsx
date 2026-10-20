import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { FileDiff, HunkAction, HunkSelection, RepoId } from "../../lib/ipc";
import { useDiffPrefs } from "../../lib/store/diffPrefs";
import { useWorkspace, type SelectedFile } from "../../lib/store/workspace";
import { BlameView } from "../history/BlameView";
import { ConflictEditor } from "../merge/editor/ConflictEditor";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { useWorktreeActions } from "../worktree/useWorktreeActions";
import { BinaryPlaceholder } from "./BinaryPlaceholder";
import { DiffToolbar } from "./DiffToolbar";
import { DiffViewer } from "./DiffViewer";
import { FileHeader } from "./FileHeader";
import { ImageDiff } from "./ImageDiff";
import { isDecoded } from "./model/encoding";
import { isImagePath } from "./model/images";
import { FULL_DIFF_LINES } from "./model/limits";
import { commitOf, isReadOnly, scopeId } from "./model/scope";
import { useFileDiff } from "./useFileDiff";
import { useHighlight } from "./useHighlight";
import { useLineSelection } from "./useLineSelection";
import styles from "./DetailPane.module.css";

const WHITESPACE_REASON = "Turn off “Hide whitespace changes” to stage, unstage or discard hunks";
const DECODED_REASON =
  "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel";
const PENDING_REASON = "Applying changes…";

/** A discard awaiting confirmation, bound to the diff it was chosen on. */
interface PendingDiscard {
  diff: FileDiff;
  selection: HunkSelection;
}

/** The selected file's diff or blame; renders nothing without a selection, so RepoPane decides what shows. */
export function DetailPane({ repoId }: { repoId: RepoId }) {
  const file = useWorkspace((s) => s.selected[repoId] ?? null);
  const { status } = useStatus(repoId);
  if (file === null) return null;
  // A conflicted path's working-tree side is edited in place; its staged side keeps the diff.
  const conflicted =
    file.scope === "unstaged" &&
    (status?.entries.some((e) => e.path === file.path && e.conflicted) ?? false);
  if (conflicted) {
    return <ConflictEditor key={`conflict:${file.path}`} repoId={repoId} path={file.path} />;
  }
  // Keyed so line cap, dialog, action error and scroll offset never leak to another file.
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
  const { mode, ignoreWhitespace, setMode, setIgnoreWhitespace } = useDiffPrefs();
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
  const selection = useLineSelection(diff);
  const actions = useWorktreeActions(repoId);
  const [pending, setPending] = useState<PendingDiscard | null>(null);
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

  const reason = ignoreWhitespace
    ? WHITESPACE_REASON
    : isDecoded(diff)
      ? DECODED_REASON
      : actions.pending
        ? PENDING_REASON
        : undefined;
  const onHunkAction = (action: HunkAction, sel: HunkSelection) => {
    if (action === "discard") setPending({ diff, selection: sel });
    else actions.applyHunk(diff.path, action, sel);
  };
  // A discard chosen on an older diff is dropped: its indices may name other lines now.
  // Cleared during render (R2), so the stale request never reaches the dialog.
  if (pending !== null && pending.diff !== diff) setPending(null);
  const confirmOpen = pending !== null && pending.diff === diff;
  const n = pending?.selection.lines?.length ?? 0;
  return (
    <div className={styles.root}>
      {header(diff.oldPath)}
      <DiffToolbar
        diff={diff}
        mode={mode}
        ignoreWhitespace={ignoreWhitespace}
        onModeChange={setMode}
        onIgnoreWhitespaceChange={setIgnoreWhitespace}
        onLoadFull={() => setMaxLines(FULL_DIFF_LINES)}
      />
      {actions.error && (
        <RepoError error={actions.error} path={null} onDismiss={actions.clearError} />
      )}
      {diff.hunks.length === 0 ? (
        <Empty>
          {encodingChanged(diff) ? "Only the encoding changed" : "No line changes in this file"}
        </Empty>
      ) : (
        <DiffViewer
          diff={diff}
          mode={mode}
          highlight={highlight}
          {...(readOnly ? {} : { selection, onHunkAction, actionsDisabledReason: reason })}
        />
      )}
      {!readOnly && (
        <ConfirmDialog
          open={confirmOpen}
          title="Discard changes"
          danger
          confirmLabel="Discard"
          body={
            n > 0
              ? `Discard ${n} selected ${n === 1 ? "line" : "lines"} in ${diff.path}? This cannot be undone.`
              : `Discard this hunk in ${diff.path}? This cannot be undone.`
          }
          onCancel={() => setPending(null)}
          onConfirm={() => {
            actions.applyHunk(diff.path, "discard", (pending as PendingDiscard).selection);
            setPending(null);
          }}
        />
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
