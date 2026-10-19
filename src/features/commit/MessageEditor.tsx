import { useId, useRef } from "react";
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
}

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
  const { subject, body, disabled, onSubjectChange, onBodyChange, onSubmit } = props;
  const bodyId = useId();
  const hintId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const over = subject.length > SUBJECT_LIMIT;

  const focusBody = () => bodyRef.current?.focus();

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
        className={styles.subject}
        type="text"
        value={subject}
        placeholder="Summary of changes"
        disabled={disabled}
        aria-describedby={over ? hintId : undefined}
        onChange={(e) => onSubjectChange(e.target.value)}
        onKeyDown={(e) => handleEnter(e, onSubmit, focusBody)}
      />
      {over && (
        <p id={hintId} className={styles.hint}>
          Keep the subject at {SUBJECT_LIMIT} characters or fewer
        </p>
      )}
      <label htmlFor={bodyId} className={styles.label}>
        Body
      </label>
      <textarea
        id={bodyId}
        ref={bodyRef}
        className={styles.body}
        value={body}
        placeholder="Optional longer description"
        rows={4}
        disabled={disabled}
        onChange={(e) => onBodyChange(e.target.value)}
        onKeyDown={(e) => handleEnter(e, onSubmit, null)}
      />
    </div>
  );
}
