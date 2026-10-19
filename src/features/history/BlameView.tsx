import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { RepoId } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { LineContent } from "../diff/LineContent";
import type { Range } from "../diff/model/wordDiff";
import { useTextHighlight } from "../diff/useTextHighlight";
import { shortOid } from "../graph/model/layout";
import { fullDate, relativeTime } from "../graph/model/relativeTime";
import { useNow } from "../graph/useNow";
import { RepoError } from "../repo/RepoError";
import { blameRows } from "./model/blameRows";
import { useBlame } from "./useBlame";
import styles from "./BlameView.module.css";

export interface BlameViewProps {
  repoId: RepoId;
  path: string;
  /** The commit to blame at; null blames HEAD. */
  oid: string | null;
}

// Module-level so the virtualizer's measurement cache is not rebuilt on every render.
const getItemKey = (index: number) => index;
const estimateSize = () => 22;
/** Blame has no word diff. */
const NO_RANGES: Range[] = [];

/** Each line of `path` beside the commit that last changed it; a hash opens that commit. */
export function BlameView({ repoId, path, oid }: BlameViewProps) {
  const { blame, error, refetch } = useBlame(repoId, path, oid);
  const tokens = useTextHighlight(path, blame?.lines);
  const selectCommit = useWorkspace((s) => s.selectCommit);
  const setCentreView = useWorkspace((s) => s.setCentreView);
  const selected = useWorkspace((s) => s.selectedCommit[repoId] ?? null);
  const now = useNow();
  const rows = useMemo(() => (blame === undefined ? [] : blameRows(blame)), [blame]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // No React Compiler is installed, so nothing memoizes the virtualizer's functions anyway.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 20,
    getItemKey,
  });

  if (error !== null) {
    return (
      <RepoError
        error={error}
        path={null}
        onRetry={refetch}
        onDismiss={() => setCentreView(repoId, "diff")}
      />
    );
  }
  if (blame === undefined) return <p role="status">Loading blame…</p>;

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label="Blame"
      aria-rowcount={rows.length}
      className={styles.scroll}
    >
      <div
        role="presentation"
        className={styles.inner}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const { index, hunk, hunkIndex, firstOfHunk } = rows[item.index];
          return (
            <div
              key={item.key}
              role="presentation"
              className={styles.item}
              style={{ transform: `translateY(${item.start}px)`, height: item.size }}
            >
              <div
                role="row"
                aria-rowindex={index + 1}
                className={styles.row}
                data-hunk-parity={hunkIndex % 2}
                data-current={hunk.oid === selected ? "true" : undefined}
              >
                <span role="cell" className={styles.hash}>
                  {firstOfHunk && (
                    <button
                      type="button"
                      className={styles.open}
                      title={`${hunk.oid} ${hunk.summary}`}
                      aria-label={`Open commit ${shortOid(hunk.oid)}`}
                      onClick={() => selectCommit(repoId, hunk.oid)}
                    >
                      {shortOid(hunk.oid)}
                    </button>
                  )}
                </span>
                <span role="cell" className={styles.author}>
                  {firstOfHunk && <span title={hunk.author.email}>{hunk.author.name}</span>}
                </span>
                <span role="cell" className={styles.date}>
                  {firstOfHunk && (
                    <span title={fullDate(hunk.author.time)}>
                      {relativeTime(hunk.author.time, now * 1000)}
                    </span>
                  )}
                </span>
                <span role="cell" className={styles.lineno}>
                  {index + 1}
                </span>
                <span role="cell" className={styles.content}>
                  <LineContent
                    text={blame.lines[index]}
                    tokens={tokens?.[index] ?? null}
                    ranges={NO_RANGES}
                    noNewlineAtEof={false}
                  />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
