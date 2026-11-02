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

  // The +n pill's width as last used by measure; null until a pill has been measured.
  const moreWidthRef = useRef<number | null>(null);
  // Re-measures effect B has made since the last external trigger; capped at MAX_LABELS.
  const remeasuresRef = useRef(0);
  // The +n pill's drawn width, or the MORE_PILL_PX estimate before it is laid out.
  const moreWidth = () => moreRef.current?.offsetWidth || MORE_PILL_PX;
  const measure = () => {
    // Unset after unmount, when a late observer callback may still arrive.
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const widths = pillRefs.current
      .slice(0, candidateCount)
      .map((el) => (el as HTMLElement).offsetWidth);
    if (parent.clientWidth === 0 || widths.some((w) => w === 0)) {
      setFit(null);
      return;
    }
    const budget = parent.clientWidth - SUBJECT_RESERVE_PX - MESSAGE_GAP_PX;
    const more = moreWidth();
    if (moreRef.current) moreWidthRef.current = more;
    setFit(fitLabels(widths, LABEL_GAP_PX, budget, more, total));
  };
  // The observer outlives renders, so it calls the latest measure through this ref.
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });

  // One observer per label set: measure on mount and when the candidates or the total change,
  // then on every resize of the parent cell. React skips the re-render when the fitted count is
  // unchanged. Each of these external triggers resets the re-measure cap.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    remeasuresRef.current = 0;
    measureRef.current();
    const ro = new ResizeObserver(() => {
      remeasuresRef.current = 0;
      measureRef.current();
    });
    ro.observe(root.parentElement as HTMLElement);
    return () => ro.disconnect();
    // candidateKey and total are the triggers; measure reads the rest through refs.
  }, [candidateKey, total]);

  // A changed fit can draw a +n pill of a new width. When it differs from the width the last
  // measure used, measure once more with the drawn width. A pill width that grows with n settles
  // in one pass; one that does not could flip the fit back and forth, so the re-measures per
  // trigger are capped at MAX_LABELS (the fit has at most that many values to try).
  useLayoutEffect(() => {
    if (!moreRef.current) return;
    const drawn = moreWidth();
    if (drawn === moreWidthRef.current || remeasuresRef.current >= MAX_LABELS) return;
    remeasuresRef.current += 1;
    moreWidthRef.current = drawn;
    measureRef.current();
    // fit is the trigger; the pill is read through refs.
  }, [fit]);

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
