import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { FileHistoryEntry, RepoId } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { useLogSummary } from "../graph/useLogSummary";
import { useNow } from "../graph/useNow";
import { RepoError } from "../repo/RepoError";
import { HistoryRow, historyRowHeight } from "./HistoryRow";
import { FILE_HISTORY_MIN_LOADED, useFileHistory } from "./useFileHistory";
import styles from "./FileHistoryPanel.module.css";

export interface FileHistoryPanelProps {
  repoId: RepoId;
  path: string;
}

/** Selects an entry's commit and opens the file under the path it had in that commit. */
function selectEntry(repoId: RepoId, entry: FileHistoryEntry) {
  const { selectCommit, select } = useWorkspace.getState();
  selectCommit(repoId, entry.oid);
  select(repoId, { path: entry.path, scope: { commit: entry.oid } });
}

/** The commits that touched one file, in the refs column; Close or Escape leaves history mode. */
export function FileHistoryPanel({ repoId, path }: FileHistoryPanelProps) {
  const { summary, error: summaryError, refetch: refetchSummary } = useLogSummary(repoId);
  const history = useFileHistory(repoId, summary?.generation, path, summary?.complete ?? false);
  const { entries, hasMore, isFetchingMore, fetchMore } = history;
  const showHistory = useWorkspace((s) => s.showHistory);
  const close = () => showHistory(repoId, null);

  // First load of a path selects its newest commit, once: a later generation (a commit, a
  // branch switch) refetches the list but must not snap the selection back.
  const autoSelected = useRef<string | null>(null);
  useEffect(() => {
    if (entries === undefined || autoSelected.current === path) return;
    autoSelected.current = path;
    if (entries.length === 0) return;
    const current = useWorkspace.getState().selectedCommit[repoId] ?? null;
    if (entries.some((e) => e.oid === current)) return;
    selectEntry(repoId, entries[0]);
  }, [entries, path, repoId]);

  // A short history fills in without scrolling: each page scans a bounded number of rows, so a
  // rarely touched file can come back with few entries and a nextRow.
  useEffect(() => {
    if (
      entries !== undefined &&
      entries.length < FILE_HISTORY_MIN_LOADED &&
      hasMore &&
      !isFetchingMore
    ) {
      fetchMore();
    }
  }, [entries, hasMore, isFetchingMore, fetchMore]);

  let body: React.ReactNode;
  if (summaryError !== null) {
    body = (
      <RepoError error={summaryError} path={null} onRetry={refetchSummary} onDismiss={close} />
    );
  } else if (history.error !== null) {
    body = (
      <RepoError error={history.error} path={null} onRetry={history.refetch} onDismiss={close} />
    );
  } else if (entries === undefined) {
    body = <p role="status">Loading history…</p>;
  } else if (entries.length === 0) {
    body = <p className={styles.empty}>No commits touch this file</p>;
  } else {
    body = (
      <HistoryList
        repoId={repoId}
        entries={entries}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
        onEndReached={fetchMore}
      />
    );
  }

  return (
    <section
      aria-label="File history"
      className={styles.root}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>History</h2>
        <span className={styles.path} title={path}>
          {path}
        </span>
        <button type="button" aria-label="Close file history" onClick={close}>
          Close
        </button>
      </header>
      {body}
    </section>
  );
}

// Module-level so the virtualizer's measurement cache is not rebuilt on every render.
const getItemKey = (index: number) => index;

interface HistoryListProps {
  repoId: RepoId;
  entries: FileHistoryEntry[];
  hasMore: boolean;
  isFetchingMore: boolean;
  /** Called when the rendered window reaches the last entries while more remain. */
  onEndReached(): void;
}

/** How close to the last loaded entry the rendered window gets before the next page is fetched. */
const END_THRESHOLD = 10;

/** The virtualized listbox of a non-empty history, with a Loading more… line under it. */
function HistoryList({ repoId, entries, hasMore, isFetchingMore, onEndReached }: HistoryListProps) {
  const selected = useWorkspace((s) => s.selectedCommit[repoId] ?? null);
  const now = useNow();
  const idPrefix = useId();
  const rowId = (index: number) => `${idPrefix}-row-${index}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimateSize = useCallback((i: number) => historyRowHeight(entries[i]), [entries]);

  // No React Compiler is installed, so nothing memoizes the virtualizer's functions anyway.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 20,
    getItemKey,
  });
  const items = virtualizer.getVirtualItems();
  const selectedIndex = entries.findIndex((e) => e.oid === selected);

  const lastRendered = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !isFetchingMore && lastRendered >= entries.length - END_THRESHOLD) {
      onEndReached();
    }
  }, [hasMore, isFetchingMore, lastRendered, entries.length, onEndReached]);

  const selectIndex = (index: number) => {
    virtualizer.scrollToIndex(index);
    selectEntry(repoId, entries[index]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // -1 makes ArrowDown and Enter start at the first entry when nothing here is selected.
    const last = entries.length - 1;
    let target: number;
    switch (e.key) {
      case "ArrowDown":
        target = Math.min(selectedIndex + 1, last);
        break;
      case "ArrowUp":
        target = Math.max(selectedIndex - 1, 0);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      case "Enter":
        // Re-selecting reopens the file when its diff was closed.
        target = Math.max(selectedIndex, 0);
        break;
      default:
        return;
    }
    // The scroll container would otherwise scroll natively as well.
    e.preventDefault();
    selectIndex(target);
  };

  return (
    <>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="File history"
        tabIndex={0}
        aria-activedescendant={selectedIndex === -1 ? undefined : rowId(selectedIndex)}
        className={styles.list}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          role="presentation"
          className={styles.inner}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const entry = entries[item.index];
            return (
              <div
                key={item.key}
                role="presentation"
                className={styles.item}
                style={{ transform: `translateY(${item.start}px)`, height: item.size }}
              >
                <HistoryRow
                  entry={entry}
                  now={now}
                  selected={entry.oid === selected}
                  id={rowId(item.index)}
                  onSelect={() => selectEntry(repoId, entry)}
                />
              </div>
            );
          })}
        </div>
      </div>
      {isFetchingMore && (
        <p role="status" className={styles.more}>
          Loading more…
        </p>
      )}
    </>
  );
}
