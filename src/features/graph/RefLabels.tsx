import { useLayoutEffect, useRef, useState } from "react";
import type { RefLabel } from "../../lib/ipc";
import { LABEL_GAP_PX, MAX_LABELS, MESSAGE_GAP_PX } from "./model/layout";
import { MORE_PILL_PX, SUBJECT_RESERVE_PX, fitLabels } from "./model/refLabelFit";
import styles from "./RefLabels.module.css";

export interface RefLabelsProps {
  refs: RefLabel[];
}

/**
 * Ref pills for a row: up to MAX_LABELS candidates, as many as fit beside the subject, then a
 * `+n` pill whose title lists the rest. Candidates that do not fit stay in the DOM, hidden, so
 * they remain measurable.
 */
export function RefLabels({ refs }: RefLabelsProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const pillRefs = useRef<(HTMLElement | null)[]>([]);
  const moreRef = useRef<HTMLSpanElement>(null);
  // null until measured: every candidate shows.
  const [fit, setFit] = useState<number | null>(null);
  const candidates = refs.slice(0, MAX_LABELS);
  const candidateCount = candidates.length;
  const total = refs.length;
  // Re-measure when the candidates change, not on every new refs array.
  const candidateKey = candidates.map((l) => `${l.kind}:${l.name}`).join("\n");

  // Measure on mount, when the candidates change and on every resize of the parent cell. React
  // skips the re-render when the fitted count is unchanged. A changed fit measures once more, so
  // a newly rendered +n pill's own width replaces the MORE_PILL_PX estimate; once the pill is
  // drawn its width is fixed and the second pass returns the same count.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const parent = root.parentElement as HTMLElement;
    const measure = () => {
      const widths = pillRefs.current
        .slice(0, candidateCount)
        .map((el) => (el as HTMLElement).offsetWidth);
      if (parent.clientWidth === 0 || widths.some((w) => w === 0)) {
        setFit(null);
        return;
      }
      const budget = parent.clientWidth - SUBJECT_RESERVE_PX - MESSAGE_GAP_PX;
      const moreWidth = moreRef.current?.offsetWidth || MORE_PILL_PX;
      setFit(fitLabels(widths, LABEL_GAP_PX, budget, moreWidth, total));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
    // candidateKey and fit are the triggers; candidateCount follows from candidateKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, total, fit]);

  if (refs.length === 0) return null;
  const shown = Math.min(fit ?? candidateCount, candidateCount);
  const hidden = refs.slice(shown);
  const hiddenNames = hidden.map((l) => l.name);
  return (
    <span ref={rootRef} className={styles.root} style={{ gap: LABEL_GAP_PX }}>
      {candidates.map((label, i) => (
        <span
          key={`${label.kind}:${label.name}`}
          ref={(el) => {
            pillRefs.current[i] = el;
          }}
          className={`${styles.pill} ${styles[label.kind]} ${label.isHead ? styles.head : ""}`}
          title={label.name}
          aria-current={(label.kind === "branch" && label.isHead) || undefined}
          data-hidden={i >= shown ? "true" : undefined}
        >
          {label.name}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          ref={moreRef}
          className={`${styles.pill} ${styles.more}`}
          title={hiddenNames.join("\n")}
        >
          {`+${hidden.length}`}
          <span className={styles.srOnly}>{` more: ${hiddenNames.join(", ")}`}</span>
        </span>
      )}
    </span>
  );
}
