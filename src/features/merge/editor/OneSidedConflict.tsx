import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConflictKind, RepoId } from "../../../lib/ipc";
import { useWorkspace } from "../../../lib/store/workspace";
import { HIGHLIGHT_LIMIT } from "../../diff/model/limits";
import { useFileContent } from "../../diff/useFileContent";
import { RepoError } from "../../repo/RepoError";
import { ConflictToolbar } from "./ConflictToolbar";
import { EditorPane } from "./EditorPane";
import type { BlockLabels } from "./model/blocks";
import { decodeEditable, lineCount, REASONS, reasonFor } from "./model/text";
import { useEditorLanguage } from "./useEditorLanguage";
import { useOneSidedResolution } from "./useOneSidedResolution";
import styles from "./ConflictEditor.module.css";

export interface OneSidedConflictProps {
  repoId: RepoId;
  path: string;
  kind: ConflictKind;
  /** { ours, theirs } from sideLabels. */
  labels: BlockLabels;
  onClose(): void;
}

/** Who deleted and who modified, by kind. */
export function sidesOf(
  kind: ConflictKind,
  labels: BlockLabels,
): { deleter: string; modifier: string } {
  return kind === "deletedByUs"
    ? { deleter: labels.ours, modifier: labels.theirs }
    : { deleter: labels.theirs, modifier: labels.ours };
}

/** A modify/delete conflict: who did what, Keep file / Delete file, and the surviving contents. */
export function OneSidedConflict({ repoId, path, kind, labels, onClose }: OneSidedConflictProps) {
  const { bytes, error } = useFileContent(repoId, path, "unstaged", "new", true);
  const decoded = useMemo(() => (bytes === undefined ? null : decodeEditable(bytes)), [bytes]);
  const resolution = useOneSidedResolution(repoId, path, kind);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { deleter, modifier } = sidesOf(kind, labels);

  const keep = async () => {
    const e = await resolution.keepFile();
    if (e === null) useWorkspace.getState().select(repoId, { path, scope: "staged" });
  };
  const remove = async () => {
    const e = await resolution.deleteFile();
    if (e !== null) return;
    // Deleting on our side leaves nothing staged to show; their deletion is a staged change.
    useWorkspace
      .getState()
      .select(repoId, kind === "deletedByUs" ? null : { path, scope: "staged" });
  };

  // Bytes already in hand win over a later refetch error, as in the marker editor.
  let body: React.ReactNode;
  if (decoded !== null && typeof decoded !== "string") {
    body = (
      <div className={styles.editor}>
        <SurvivingFile path={path} source={decoded.text} />
      </div>
    );
  } else {
    let reason: string | null = null;
    if (decoded !== null) reason = REASONS[decoded];
    else if (error !== null) reason = reasonFor(error);
    body =
      reason === null ? (
        <div className={styles.empty}>
          <p role="status">Loading {name}…</p>
        </div>
      ) : (
        <div className={styles.empty}>
          <h2 className={styles.heading}>Can’t edit {name} here</h2>
          <p className={styles.message}>{reason}</p>
        </div>
      );
  }

  return (
    <div className={styles.root}>
      <ConflictToolbar
        path={path}
        remaining={null}
        canPickAll={false}
        labels={labels}
        pending={false}
        onClose={onClose}
      />
      {resolution.error && (
        <RepoError error={resolution.error} path={null} onDismiss={resolution.clearError} />
      )}
      <div className={styles.notice}>
        <p className={styles.message}>
          Deleted on {deleter}, modified on {modifier}.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            data-variant="neutral"
            disabled={resolution.pending}
            onClick={() => void keep()}
          >
            Keep file
          </button>
          <button
            type="button"
            data-variant="danger"
            disabled={resolution.pending}
            onClick={() => void remove()}
          >
            Delete file
          </button>
        </div>
      </div>
      {body}
    </div>
  );
}

const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/** The surviving file's contents, read-only and highlighted; a refetch replaces the document. */
function SurvivingFile({ path, source }: { path: string; source: string }) {
  const viewRef = useRef<EditorView | null>(null);
  const [languageComp] = useState(() => new Compartment());
  const [extensions] = useState(() => [...readOnly, languageComp.of([])]);

  useEditorLanguage(viewRef, languageComp, path, lineCount(source) > HIGHLIGHT_LIMIT);

  useEffect(() => {
    const v = viewRef.current as EditorView;
    const doc = v.state.doc.toString();
    if (source !== doc) v.dispatch({ changes: { from: 0, to: doc.length, insert: source } });
  }, [source]);

  return (
    <EditorPane
      initialText={source}
      extensions={extensions}
      onDocChange={() => undefined}
      viewRef={viewRef}
      ariaLabel="Surviving file"
    />
  );
}
