import { useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import styles from "./CloneDialog.module.css";

export type CloneSource = "url" | "account";

const LABEL: Record<CloneSource, string> = { url: "URL", account: "From account" };

const other = (source: CloneSource): CloneSource => (source === "url" ? "account" : "url");

/** Where each key moves the selection; with two tabs both arrows wrap to the other one. */
const KEYS: Partial<Record<string, (source: CloneSource) => CloneSource>> = {
  ArrowRight: other,
  ArrowLeft: other,
  Home: () => "url",
  End: () => "account",
};

/** The ids that tie a tab to its panel; the panels live in the dialog. */
export const cloneSourceIds = (idBase: string, source: CloneSource) => ({
  tab: `${idBase}-tab-${source}`,
  panel: `${idBase}-panel-${source}`,
});

export interface CloneSourceTabsProps {
  idBase: string;
  selected: CloneSource;
  onSelect(source: CloneSource): void;
  disabled: boolean;
  /** Lands on the From account tab, the accounts dialog's fallback focus. */
  accountTabRef: RefObject<HTMLButtonElement | null>;
}

/** The clone dialog's WAI-ARIA tab strip: roving tabindex; the arrows, Home and End select and focus. */
export function CloneSourceTabs({
  idBase,
  selected,
  onSelect,
  disabled,
  accountTabRef,
}: CloneSourceTabsProps) {
  const urlTabRef = useRef<HTMLButtonElement>(null);
  const refs = { url: urlTabRef, account: accountTabRef };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = KEYS[e.key]?.(selected);
    if (next === undefined) return;
    e.preventDefault();
    onSelect(next);
    (refs[next].current as HTMLButtonElement).focus();
  };

  return (
    <div role="tablist" aria-label="Clone source" className={styles.tabs} onKeyDown={onKeyDown}>
      {(["url", "account"] as const).map((source) => {
        const ids = cloneSourceIds(idBase, source);
        return (
          <button
            key={source}
            ref={refs[source]}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected === source}
            aria-controls={ids.panel}
            tabIndex={selected === source ? 0 : -1}
            disabled={disabled}
            className={styles.tab}
            onClick={() => onSelect(source)}
          >
            {LABEL[source]}
          </button>
        );
      })}
    </div>
  );
}
