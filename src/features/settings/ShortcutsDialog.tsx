import { useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { SHORTCUTS, SHORTCUT_GROUPS, formatKeyParts } from "../../lib/shortcuts";
import type { EffectiveBindings, ShortcutGroup } from "../../lib/shortcuts";
import type { ShortcutKeycaps } from "../../lib/ipc";
import { useEffectiveBindings, useKeycaps } from "../../lib/shortcuts/useShortcutKeys";
import { useShell } from "../../lib/store/shell";
import { KeyParts } from "./KeyParts";
import styles from "./ShortcutsDialog.module.css";

export interface ShortcutsDialogProps {
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

/**
 * A plain Action/Shortcut row: either a registry shortcut or one of the static Navigation rows.
 * `parts` is `null` for an unbound shortcut.
 */
interface Row {
  label: string;
  parts: string[] | null;
}

/** The extra Navigation rows that describe behaviour without a single chord. */
const STATIC_NAVIGATION: Row[] = [
  { label: "Close dialog or menu", parts: ["Escape"] },
  { label: "Move within lists and menus", parts: ["Arrow keys"] },
];

function rowsFor(
  group: ShortcutGroup,
  bindings: EffectiveBindings,
  keycaps: ShortcutKeycaps,
): Row[] {
  const rows: Row[] = SHORTCUTS.filter((s) => s.group === group).map((s) => {
    const keys = bindings[s.id];
    return { label: s.label, parts: keys === null ? null : formatKeyParts(keys, keycaps) };
  });
  return group === "Navigation" ? [...rows, ...STATIC_NAVIGATION] : rows;
}

/** The reference of every keyboard shortcut, grouped into one table per group. */
export function ShortcutsDialog({ onClose, fallbackFocus }: ShortcutsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bindings = useEffectiveBindings();
  const keycaps = useKeycaps();

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    onClose();
  };

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Keyboard shortcuts
        </h2>
        {SHORTCUT_GROUPS.map((group) => (
          <table key={group} className={styles.table}>
            <caption className={styles.caption}>{group}</caption>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Shortcut</th>
              </tr>
            </thead>
            <tbody>
              {rowsFor(group, bindings, keycaps).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className={styles.keys}>
                    <KeyParts parts={row.parts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => useShell.getState().open({ kind: "settings", section: "shortcuts" })}
          >
            Customize…
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
