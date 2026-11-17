import { forwardRef } from "react";
import type { KeyboardEvent } from "react";
import styles from "./SearchBar.module.css";

export interface SearchBarProps {
  query: string;
  wholeWord: boolean;
  matchCase: boolean;
  /** Index of the current hit, null when none. */
  current: number | null;
  total: number;
  capped: boolean;
  onQueryChange(q: string): void;
  onToggleWholeWord(): void;
  onToggleMatchCase(): void;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
}

function Chevron({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function counter({ query, current, total, capped }: SearchBarProps): string {
  if (query === "") return "";
  if (total === 0) return "0/0";
  return `${(current ?? 0) + 1}/${total}${capped ? "+" : ""}`;
}

/** The find-in-diff bar; the ref is the text field. */
export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  function SearchBar(props, ref) {
    const { query, wholeWord, matchCase, total, onQueryChange, onNext, onPrev, onClose } = props;
    const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? onPrev : onNext)();
    };
    // Escape from the field or any control in the bar closes it.
    const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    return (
      <div role="search" aria-label="Find in diff" className={styles.root} onKeyDown={onBarKeyDown}>
        <input
          ref={ref}
          type="text"
          aria-label="Find"
          placeholder="Find"
          value={query}
          data-state={query && total === 0 ? "no-results" : undefined}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onFieldKeyDown}
        />
        <span aria-live="polite" className={styles.count}>
          {counter(props)}
        </span>
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={total === 0}
          onClick={onPrev}
        >
          <Chevron d="M4 12l6-6 6 6" />
        </button>
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={total === 0}
          onClick={onNext}
        >
          <Chevron d="M4 8l6 6 6-6" />
        </button>
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          aria-label="Match whole word"
          title="Match whole word"
          aria-pressed={wholeWord}
          onClick={props.onToggleWholeWord}
        >
          ab|
        </button>
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          aria-label="Match case"
          title="Match case"
          aria-pressed={matchCase}
          onClick={props.onToggleMatchCase}
        >
          Aa
        </button>
        <button
          type="button"
          data-variant="ghost"
          data-size="sm"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    );
  },
);
