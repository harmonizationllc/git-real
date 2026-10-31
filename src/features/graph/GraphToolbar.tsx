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
  /** Commits in the graph so far. */
  total: number;
  /** False while the graph is still being built and `total` can grow. */
  complete: boolean;
  /** True while a rebuild runs behind the served graph. */
  refreshing: boolean;
}

const fmt = (n: number) => n.toLocaleString();

function countText(total: number, complete: boolean, refreshing: boolean): string {
  if (!complete) return `Loading… ${fmt(total)} commits`;
  if (refreshing) return `Updating… ${fmt(total)} commits`;
  return total === 1 ? "1 commit" : `${fmt(total)} commits`;
}

function counterText(
  query: string,
  matchCount: number | null,
  current: number,
  complete: boolean,
): string | null {
  if (query !== "" && !complete) return "Loading…";
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
  total,
  complete,
  refreshing,
}: GraphToolbarProps) {
  const counter = counterText(query, matchCount, current, complete);
  const noMatches = !matchCount || !complete;
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
      {/* Not live: a screen reader would otherwise read the growing count twice a second. */}
      <span role="status" aria-live="off" className={styles.count}>
        {countText(total, complete, refreshing)}
      </span>
    </div>
  );
}
