import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import styles from "./SettingsDialog.module.css";

export interface TextSettingProps {
  id: string;
  label: string;
  value: string | null;
  placeholder?: string;
  hint?: string;
  /** Persists `next`; resolves an inline error message (empty string = revert, no message) or null. */
  onCommit(next: string | null): Promise<string | null>;
}

/**
 * A labelled text field that commits on blur or Enter when its value changed. An inline error from
 * `onCommit` is kept after Enter and reverted after blur; an empty string reverts without a message.
 */
export function TextSetting({ id, label, value, placeholder, hint, onCommit }: TextSettingProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();

  // Follow the stored value when it changes outside this field (another save, a reset).
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(value ?? "");
    setError(null);
  }

  const commit = async (revertOnError: boolean) => {
    const next = draft === "" ? null : draft;
    if (next === value) return;
    const message = await onCommit(next);
    if (message !== null) {
      setError(message);
      if (revertOnError) setDraft(value ?? "");
    } else {
      setError(null);
      setDraft(next ?? "");
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    void commit(false);
  };

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={describedBy || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(true)}
        onKeyDown={onKeyDown}
      />
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
