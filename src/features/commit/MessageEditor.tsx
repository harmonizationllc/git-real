import { useId, useRef } from "react";
import { SUBJECT_LIMIT } from "./limits";
import styles from "./MessageEditor.module.css";

export interface MessageEditorProps {
  subject: string;
  body: string;
  disabled: boolean;
  onSubjectChange(value: string): void;
  onBodyChange(value: string): void;
  /** Ctrl+Enter or Cmd+Enter in either field. The parent decides whether a commit may run. */
  onSubmit(): void;
}

const isSubmitKey = (e: React.KeyboardEvent): boolean =>
  e.key === "Enter" && (e.ctrlKey || e.metaKey);

export function MessageEditor(props: MessageEditorProps): React.JSX.Element {
  const { subject, body, disabled, onSubjectChange, onBodyChange, onSubmit } = props;
  const subjectId = useId();
  const bodyId = useId();
  const hintId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const over = subject.length > SUBJECT_LIMIT;

  const onSubjectKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitKey(e)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "Enter") {
      e.preventDefault();
      bodyRef.current?.focus();
    }
  };
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitKey(e)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.subjectRow}>
        <label htmlFor={subjectId} className={styles.label}>
          Subject
        </label>
        <span className={over ? styles.counterOver : styles.counter} aria-hidden="true">
          {subject.length}/{SUBJECT_LIMIT}
        </span>
      </div>
      <input
        id={subjectId}
        className={styles.subject}
        type="text"
        value={subject}
        placeholder="Summary of changes"
        disabled={disabled}
        aria-describedby={over ? hintId : undefined}
        onChange={(e) => onSubjectChange(e.target.value)}
        onKeyDown={onSubjectKeyDown}
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
        onKeyDown={onBodyKeyDown}
      />
    </div>
  );
}
