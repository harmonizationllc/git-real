import { Compartment, Transaction, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { AppError, ConflictSide, RepoId } from "../../../lib/ipc";
import { useWorkspace } from "../../../lib/store/workspace";
import { useBranches } from "../../branches/useBranches";
import { languageFor, loadLanguage } from "../../diff/model/highlight";
import { HIGHLIGHT_LIMIT } from "../../diff/model/limits";
import { useFileContent } from "../../diff/useFileContent";
import { RepoError } from "../../repo/RepoError";
import { headName, sideLabels } from "../operationCopy";
import { useIntegrationActions } from "../useIntegrationActions";
import { useOperationState } from "../useOperationState";
import { ConflictToolbar } from "./ConflictToolbar";
import { EditorPane } from "./EditorPane";
import {
  blockLabels,
  blocksOf,
  conflictBlocks,
  goToConflict,
  pickAll,
  remainingConflicts,
  resetBlocks,
  type BlockLabels,
} from "./model/blocks";
import { parseConflicts } from "./model/markers";
import { decodeEditable, lineCount, type NotEditable } from "./model/text";
import { useResolutionWriter } from "./useResolutionWriter";
import styles from "./ConflictEditor.module.css";

const REASONS: Record<NotEditable | "missing", string> = {
  tooLarge: "It is larger than 2 MB.",
  notText: "It is not UTF-8 text.",
  missing: "It is missing from the working tree.",
};

/** Why the file could not be read for editing, as placeholder copy. */
function reasonFor(error: AppError): string {
  switch (error.kind) {
    case "tooLarge":
      return REASONS.tooLarge;
    case "binaryFile":
      return REASONS.notText;
    case "pathNotFound":
      return REASONS.missing;
    default:
      return error.message;
  }
}

interface Summary {
  remaining: number;
  canPickAll: boolean;
}

/** The toolbar's live state: markers left (re-parsed) and whether a bulk pick has a block to take. */
const summarize = (state: EditorState): Summary => ({
  remaining: remainingConflicts(state),
  canPickAll: blocksOf(state).some((b) => b.state === "unresolved"),
});

/** The toolbar handlers the loading and placeholder states never show. */
const inactive = () => undefined;

/** Edits a conflicted working-tree file in place: loading, a placeholder, or the editor. */
export function ConflictEditor({ repoId, path }: { repoId: RepoId; path: string }) {
  const { bytes, error } = useFileContent(repoId, path, "unstaged", "new", true);
  const { state } = useOperationState(repoId);
  const { branches } = useBranches(repoId);
  const integration = useIntegrationActions(repoId);
  const labels = sideLabels(state, headName(branches?.head));
  const decoded = useMemo(() => (bytes === undefined ? null : decodeEditable(bytes)), [bytes]);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const close = () => useWorkspace.getState().select(repoId, null);

  // Bytes already in hand win over a later refetch error, so a flaky refetch keeps the editor.
  if (decoded !== null && typeof decoded !== "string") {
    return (
      <EditableConflict
        key={path}
        repoId={repoId}
        path={path}
        source={decoded.text}
        crlf={decoded.crlf}
        labels={labels}
        onClose={close}
      />
    );
  }

  const shell = (
    <ConflictToolbar
      path={path}
      remaining={null}
      canPickAll={false}
      labels={labels}
      pending={false}
      onPrevious={inactive}
      onNext={inactive}
      onKeepAll={inactive}
      onTakeAll={inactive}
      onMarkResolved={inactive}
      onClose={close}
    />
  );
  let reason: string | null = null;
  if (decoded !== null) reason = REASONS[decoded];
  else if (error !== null) reason = reasonFor(error);
  if (reason === null) {
    return (
      <div className={styles.root}>
        {shell}
        <div className={styles.empty}>
          <p role="status">Loading {name}…</p>
        </div>
      </div>
    );
  }
  const resolve = (side: ConflictSide) =>
    void integration.run({ action: "resolve", paths: [path], side });
  return (
    <div className={styles.root}>
      {shell}
      {integration.error && (
        <RepoError error={integration.error} path={null} onDismiss={integration.clearError} />
      )}
      <div className={styles.empty}>
        <h2 className={styles.heading}>Can’t edit {name} here</h2>
        <p className={styles.message}>{reason}</p>
        <div className={styles.actions}>
          <button type="button" disabled={integration.pending} onClick={() => resolve("ours")}>
            Keep {labels.ours}
          </button>
          <button type="button" disabled={integration.pending} onClick={() => resolve("theirs")}>
            Take {labels.theirs}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditableConflictProps {
  repoId: RepoId;
  path: string;
  source: string;
  crlf: boolean;
  labels: BlockLabels;
  onClose(): void;
}

function EditableConflict({ repoId, path, source, crlf, labels, onClose }: EditableConflictProps) {
  const viewRef = useRef<EditorView | null>(null);
  const writer = useResolutionWriter(repoId, path, crlf);
  // Mount-time values: later changes go through the compartments, never a new extension list.
  const [labelsComp] = useState(() => new Compartment());
  const [languageComp] = useState(() => new Compartment());
  const [extensions] = useState(() => [
    conflictBlocks(),
    labelsComp.of(blockLabels.of(labels)),
    languageComp.of([]),
  ]);
  const [summary, setSummary] = useState<Summary>(() => {
    // Every block starts unresolved, so a bulk pick is possible exactly when markers exist.
    const remaining = parseConflicts(source).length;
    return { remaining, canPickAll: remaining > 0 };
  });
  // Set only around the synchronous reload dispatch, so the reload is not saved back to disk.
  const reloading = useRef(false);
  const view = () => viewRef.current as EditorView;

  const { ours, theirs } = labels;
  useEffect(() => {
    (viewRef.current as EditorView).dispatch({
      effects: labelsComp.reconfigure(blockLabels.of({ ours, theirs })),
    });
  }, [labelsComp, ours, theirs]);

  const big = lineCount(source) > HIGHLIGHT_LIMIT;
  useEffect(() => {
    const v = viewRef.current as EditorView;
    const desc = big ? null : languageFor(path);
    if (desc === null) {
      // Also drops highlighting when a reload crosses the limit.
      v.dispatch({ effects: languageComp.reconfigure([]) });
      return;
    }
    let cancelled = false;
    loadLanguage(desc).then(
      (support) => {
        if (!cancelled) v.dispatch({ effects: languageComp.reconfigure(support) });
      },
      (e: unknown) => console.error("language load failed", e),
    );
    return () => {
      cancelled = true;
    };
  }, [languageComp, path, big]);

  // Reload rule: a disk change replaces the document unless it is the current text or our own echo.
  const onSource = useEffectEvent((next: string) => {
    const v = view();
    const doc = v.state.doc.toString();
    if (next === doc || writer.wasWritten(next)) return;
    writer.discardPending();
    reloading.current = true;
    try {
      v.dispatch({
        changes: { from: 0, to: doc.length, insert: next },
        effects: resetBlocks.of(next),
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      reloading.current = false;
    }
  });
  useEffect(() => onSource(source), [source]);

  const onDocChange = (text: string) => {
    setSummary(summarize(view().state));
    if (!reloading.current) writer.scheduleSave(text);
  };

  const markResolved = async () => {
    const e = await writer.markResolved(view().state.doc.toString());
    if (e === null) useWorkspace.getState().select(repoId, { path, scope: "staged" });
  };

  return (
    <div className={styles.root}>
      <ConflictToolbar
        path={path}
        remaining={summary.remaining}
        canPickAll={summary.canPickAll}
        labels={labels}
        pending={writer.pending}
        onPrevious={() => goToConflict(view(), -1)}
        onNext={() => goToConflict(view(), 1)}
        onKeepAll={() => pickAll(view(), "ours")}
        onTakeAll={() => pickAll(view(), "theirs")}
        onMarkResolved={() => void markResolved()}
        onClose={onClose}
      />
      {writer.error && <RepoError error={writer.error} path={null} onDismiss={writer.clearError} />}
      <div className={styles.editor}>
        <EditorPane
          initialText={source}
          extensions={extensions}
          onDocChange={onDocChange}
          viewRef={viewRef}
          ariaLabel="Conflict editor"
        />
      </div>
    </div>
  );
}
