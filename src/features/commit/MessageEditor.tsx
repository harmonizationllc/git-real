import { useId, useLayoutEffect, useRef } from "react";
import { insertIssueRef } from "./issueRef";
import { SUBJECT_LIMIT } from "./limits";
import styles from "./MessageEditor.module.css";

// Fixed so the operation banner's "Go to commit" can focus it (features/merge/OperationBanner).
const SUBJECT_ID = "commit-subject";

export interface MessageEditorProps {
  subject: string;
  body: string;
  disabled: boolean;
  onSubjectChange(value: string): void;
  onBodyChange(value: string): void;
  /** Ctrl+Enter or Cmd+Enter in either field. The parent decides whether a commit may run. */
  onSubmit(): void;
  /**
   * Shows the # button and binds Ctrl/Cmd+Shift+I; called with an inserter bound to the
   * triggering field and its caret at that moment.
   */
  onLinkIssue?(insert: IssueRefInserter): void;
}

/** Writes `text` into the field and at the caret captured when the link was requested. */
export type IssueRefInserter = (text: string) => void;

type Field = "subject" | "body";

/** Ctrl/Cmd+Shift+I outside an IME composition; Caps Lock can flip the key's case. */
const isLinkChord = (e: React.KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) &&
  e.shiftKey &&
  e.key.toLowerCase() === "i" &&
  !e.nativeEvent.isComposing &&
  e.keyCode !== 229;

/**
 * Ctrl/Cmd+Enter submits; plain Enter runs `onPlainEnter` when given, else keeps its default.
 * An Enter that confirms an IME composition is left untouched in both fields.
 */
function handleEnter(
  e: React.KeyboardEvent,
  onSubmit: () => void,
  onPlainEnter: (() => void) | null,
): void {
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    onSubmit();
  } else if (onPlainEnter !== null) {
    e.preventDefault();
    onPlainEnter();
  }
}

export function MessageEditor(props: MessageEditorProps): React.JSX.Element {
  const { subject, body, disabled, onSubjectChange, onBodyChange, onSubmit, onLinkIssue } = props;
  const bodyId = useId();
  const hintId = useId();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // The field the # button writes into, and the fields the user has focused at least once.
  const lastField = useRef<Field>("body");
  const touched = useRef(new Set<Field>());
  // Set by an insert, applied after the render that carries the new value.
  const caret = useRef<{ field: Field; pos: number } | null>(null);
  const over = subject.length > SUBJECT_LIMIT;

  const element = (field: Field) =>
    (field === "subject" ? subjectRef.current : bodyRef.current) as
      HTMLInputElement | HTMLTextAreaElement;

  const focusBody = () => bodyRef.current?.focus();

  const onFocus = (field: Field) => {
    lastField.current = field;
    touched.current.add(field);
  };

  // The selection is captured now; the value is read when the issue is picked, since the draft
  // can change meanwhile. A field never focused takes the ref at its end.
  const trigger = (link: (insert: IssueRefInserter) => void, field: Field) => {
    const el = element(field);
    const fresh = !touched.current.has(field);
    const start = fresh ? el.value.length : (el.selectionStart as number);
    const end = fresh ? el.value.length : (el.selectionEnd as number);
    link((text) => {
      const current = element(field).value;
      const clamp = (n: number) => Math.min(n, current.length);
      const next = insertIssueRef(current, clamp(start), clamp(end), text);
      (field === "subject" ? onSubjectChange : onBodyChange)(next.value);
      caret.current = { field, pos: next.caret };
    });
  };

  // Once per insert: the controlled value has landed, so the caret goes after the ref.
  useLayoutEffect(() => {
    const pending = caret.current;
    if (pending === null) return;
    caret.current = null;
    const el = element(pending.field);
    el.focus();
    el.setSelectionRange(pending.pos, pending.pos);
  });

  const onKeyDown = (e: React.KeyboardEvent, field: Field, onPlainEnter: (() => void) | null) => {
    if (onLinkIssue && !disabled && isLinkChord(e)) {
      // Consumed here, so RepoPane's window shortcuts and the webview never see it.
      e.preventDefault();
      trigger(onLinkIssue, field);
      return;
    }
    handleEnter(e, onSubmit, onPlainEnter);
  };

  return (
    <div className={styles.root}>
      <div className={styles.subjectRow}>
        <label htmlFor={SUBJECT_ID} className={styles.label}>
          Subject
        </label>
        <span className={over ? styles.counterOver : styles.counter} aria-hidden="true">
          {subject.length}/{SUBJECT_LIMIT}
        </span>
      </div>
      <input
        id={SUBJECT_ID}
        ref={subjectRef}
        className={styles.subject}
        type="text"
        value={subject}
        placeholder="Summary of changes"
        disabled={disabled}
        aria-describedby={over ? hintId : undefined}
        onChange={(e) => onSubjectChange(e.target.value)}
        onFocus={() => onFocus("subject")}
        onKeyDown={(e) => onKeyDown(e, "subject", focusBody)}
      />
      {over && (
        <p id={hintId} className={styles.hint}>
          Keep the subject at {SUBJECT_LIMIT} characters or fewer
        </p>
      )}
      <div className={styles.bodyRow}>
        <label htmlFor={bodyId} className={styles.label}>
          Body
        </label>
        {onLinkIssue && (
          <button
            type="button"
            className={styles.link}
            aria-label="Link issue"
            disabled={disabled}
            onClick={() => trigger(onLinkIssue, lastField.current)}
          >
            #
          </button>
        )}
      </div>
      <textarea
        id={bodyId}
        ref={bodyRef}
        className={styles.body}
        value={body}
        placeholder="Optional longer description"
        rows={4}
        disabled={disabled}
        onChange={(e) => onBodyChange(e.target.value)}
        onFocus={() => onFocus("body")}
        onKeyDown={(e) => onKeyDown(e, "body", null)}
      />
    </div>
  );
}
