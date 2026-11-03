import { useId, useMemo } from "react";
import type { FileDiff } from "../../lib/ipc";
import type { DiffMode } from "../../lib/ipc";
import { formatKeyParts } from "../../lib/shortcuts";
import { useKeycaps, useShortcutKeys } from "../../lib/shortcuts/useShortcutKeys";
import type { ChangeNavigation } from "./useChangeNavigation";
import { encodingNotice } from "./model/encoding";
import { totalLines } from "./model/limits";
import styles from "./DiffToolbar.module.css";

interface Props {
  diff: FileDiff;
  mode: DiffMode;
  ignoreWhitespace: boolean;
  onModeChange(mode: DiffMode): void;
  onIgnoreWhitespaceChange(on: boolean): void;
  onLoadFull(): void;
  navigation: Pick<ChangeNavigation, "count" | "current" | "next" | "prev">;
}

const MODE_LABELS: Record<DiffMode, string> = { split: "Side by side", unified: "Unified" };

export function DiffToolbar({
  diff,
  mode,
  ignoreWhitespace,
  onModeChange,
  onIgnoreWhitespaceChange,
  onLoadFull,
  navigation,
}: Props) {
  const groupName = useId();
  const { additions, deletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const h of diff.hunks) {
      for (const l of h.lines) {
        if (l.kind === "addition") additions++;
        else if (l.kind === "deletion") deletions++;
      }
    }
    return { additions, deletions };
  }, [diff]);
  const notice = encodingNotice(diff);
  const keycaps = useKeycaps();
  const nextKeys = useShortcutKeys("nextChange");
  const prevKeys = useShortcutKeys("prevChange");
  const titled = (label: string, keys: string | null) =>
    keys === null ? label : `${label} (${formatKeyParts(keys, keycaps).join("+")})`;
  const { count, current } = navigation;
  const counter =
    current !== null
      ? `${current + 1} of ${count}`
      : `${count} ${count === 1 ? "change" : "changes"}`;
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.summary}>
          <span className={styles.added}>{`+${additions}`}</span>{" "}
          <span className={styles.removed}>{`−${deletions}`}</span>
        </span>
        <div role="radiogroup" aria-label="View mode" className={styles.modes}>
          {(["split", "unified"] as const).map((m) => (
            <label key={m} className={styles.option}>
              <input
                type="radio"
                name={groupName}
                value={m}
                checked={mode === m}
                onChange={() => onModeChange(m)}
              />
              {MODE_LABELS[m]}
            </label>
          ))}
        </div>
        <div role="group" aria-label="Changes" className={styles.changes}>
          <button
            type="button"
            data-variant="ghost"
            data-size="sm"
            aria-label="Previous change"
            title={titled("Previous change", prevKeys)}
            disabled={count === 0 || current === 0}
            onClick={navigation.prev}
          >
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
              <path d="M4 12l6-6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            data-variant="ghost"
            data-size="sm"
            aria-label="Next change"
            title={titled("Next change", nextKeys)}
            disabled={count === 0 || current === count - 1}
            onClick={navigation.next}
          >
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
              <path d="M4 8l6 6 6-6" />
            </svg>
          </button>
          <span aria-live="polite" className={styles.counter}>
            {counter}
          </span>
        </div>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(e) => onIgnoreWhitespaceChange(e.target.checked)}
          />
          Hide whitespace changes
        </label>
      </div>
      {notice && (
        <div className={styles.notice} data-testid="encoding-notice">
          {notice}
        </div>
      )}
      {diff.truncated && (
        <div className={styles.notice}>
          {/* Only the text is live, so the button label is not announced as status. */}
          <span role="status">{`Showing the first ${totalLines(diff)} lines`}</span>
          <button type="button" data-variant="ghost" data-size="sm" onClick={onLoadFull}>
            Load full diff
          </button>
        </div>
      )}
    </div>
  );
}
