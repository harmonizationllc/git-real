import styles from "./GraphToolbar.module.css";

export interface GraphToolbarProps {
  query: string;
  onQueryChange(query: string): void;
  /** Matches for the query; null while the search has not answered yet. */
  matchCount: number | null;
  /** Zero-based position of the current match. */
  current: number;
  onPrevious(): void;
  onNext(): void;
}

function counterText(query: string, matchCount: number | null, current: number): string | null {
  if (query === "" || matchCount === null) return null;
  return matchCount === 0 ? "No matches" : `${current + 1} of ${matchCount}`;
}

export function GraphToolbar({
  query,
  onQueryChange,
  matchCount,
  current,
  onPrevious,
  onNext,
}: GraphToolbarProps) {
  const counter = counterText(query, matchCount, current);
  const noMatches = !matchCount;
  return (
    <div className={styles.root}>
      <input
        type="search"
        className={styles.search}
        aria-label="Search commits"
        placeholder="Search commits"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (e.shiftKey) onPrevious();
            else onNext();
          } else if (e.key === "Escape") {
            onQueryChange("");
          }
        }}
      />
      {counter !== null && (
        <span className={styles.counter} aria-live="polite">
          {counter}
        </span>
      )}
      <button type="button" disabled={noMatches} onClick={onPrevious}>
        Previous
      </button>
      <button type="button" disabled={noMatches} onClick={onNext}>
        Next
      </button>
    </div>
  );
}
