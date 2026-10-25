import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { fuzzyIndices, MAX_PALETTE_ROWS, rankCommands } from "../../lib/fuzzy";
import type { Ranked } from "../../lib/fuzzy";
import type { ShellActions } from "../../lib/store/shell";
import { useCommands } from "./useCommands";
import type { Command, CommandGroup } from "./useCommands";
import styles from "./CommandPalette.module.css";

export interface CommandPaletteProps {
  actions: ShellActions;
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

const GROUP_ORDER: CommandGroup[] = ["Actions", "Open repositories", "Recent repositories"];

/** Highlights the matched characters of `text` with `<mark>`, for a row that matched this field. */
function highlight(text: string, query: string): ReactNode {
  const indices = query === "" ? null : fuzzyIndices(query, text);
  if (indices === null || indices.length === 0) return text;
  const marked = new Set(indices);
  const out: ReactNode[] = [];
  let run = "";
  let inMark = false;
  const flush = () => {
    if (run === "") return;
    out.push(inMark ? <mark key={out.length}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const here = marked.has(i);
    if (here !== inMark) {
      flush();
      inMark = here;
    }
    run += text[i];
  }
  flush();
  return out;
}

/** Ctrl+K palette over the shell commands and the open/recent repositories; reads no network hook. */
export function CommandPalette({ actions, onClose, fallbackFocus }: CommandPaletteProps) {
  const titleId = useId();
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useCommands(actions);
  const ranked = useMemo(() => rankCommands(query.trim(), commands), [query, commands]);

  // Re-group the score-sorted rows into the fixed group order, capped at MAX_PALETTE_ROWS total.
  const grouped = useMemo(() => {
    let budget = MAX_PALETTE_ROWS;
    const out: { group: CommandGroup; rows: Ranked<Command>[] }[] = [];
    for (const group of GROUP_ORDER) {
      const rows = ranked.filter((r) => r.item.group === group).slice(0, budget);
      budget -= rows.length;
      if (rows.length > 0) out.push({ group, rows });
    }
    return out;
  }, [ranked]);

  const flat = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (cmd: Command) => {
    if (cmd.disabledReason !== null) return;
    cmd.run();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "Escape":
        if (query !== "") setQuery("");
        else onClose();
        return;
      case "ArrowDown":
        e.preventDefault();
        setActive(Math.min(current + 1, flat.length - 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive(Math.max(current - 1, 0));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(flat.length - 1);
        return;
      case "Enter":
        e.preventDefault();
        if (flat.length > 0) run(flat[current].item);
        return;
    }
  };

  let index = -1;
  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        aria-labelledby={titleId}
        className={styles.dialog}
      >
        <h2 id={titleId} className={styles.srOnly}>
          Command palette
        </h2>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
          aria-label="Search commands"
          placeholder="Type a command or repository name"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className={styles.input}
        />
        {flat.length === 0 && <p className={styles.empty}>No matching commands</p>}
        <ul
          id={listId}
          role="listbox"
          aria-label="Commands"
          aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
          className={styles.list}
        >
          {grouped.map(({ group, rows }) => (
            <li key={group} role="presentation" className={styles.group}>
              <div className={styles.groupLabel}>{group}</div>
              <ul role="presentation" className={styles.groupList}>
                {rows.map(({ item, matched }) => {
                  index += 1;
                  const i = index;
                  const disabled = item.disabledReason !== null;
                  return (
                    <li
                      key={item.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      aria-disabled={disabled}
                      title={item.disabledReason ?? undefined}
                      className={disabled ? `${styles.option} ${styles.disabled}` : styles.option}
                      onClick={() => run(item)}
                    >
                      <span className={styles.optionLabel}>
                        {matched === "label" ? highlight(item.label, query.trim()) : item.label}
                      </span>
                      {item.detail !== undefined && (
                        <span className={styles.optionDetail}>
                          {matched === "detail"
                            ? highlight(item.detail, query.trim())
                            : item.detail}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
