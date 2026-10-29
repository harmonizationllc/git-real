import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ShortcutBindings } from "../../lib/ipc";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  chordFromEvent,
  chordToString,
  formatKeyParts,
  formatKeys,
  isBindable,
  modifierLabels,
  shortcut,
} from "../../lib/shortcuts";
import type { ShortcutId } from "../../lib/shortcuts";
import { useEffectiveBindings } from "../../lib/shortcuts/useShortcutKeys";
import { useSettings } from "../../lib/store/settings";
import { setShortcutBindings } from "../../lib/store/settingsActions";
import { Section } from "./SettingsDialog";
import { KeyParts } from "./ShortcutsDialog";
import dialogStyles from "./ShortcutsDialog.module.css";
import styles from "./SettingsDialog.module.css";

const LISTENING = "Listening for a shortcut. Press Escape to cancel.";

/** The row capturing a chord: waiting for keys, or asking before taking another row's chord. */
type Capture =
  | { id: ShortcutId; phase: "listening"; error?: string }
  | { id: ShortcutId; phase: "conflict"; chord: string; otherId: ShortcutId };

/** Saves `next`, dropping entries equal to the registry default so the file holds only overrides. */
function commit(next: ShortcutBindings): void {
  const clean = { ...next };
  for (const s of SHORTCUTS) {
    if (clean[s.id] === s.keys) delete clean[s.id];
  }
  setShortcutBindings(clean);
}

/** The Keyboard shortcuts section: press a chord to rebind a row, resolve conflicts, reset. */
export function ShortcutSettings() {
  const effective = useEffectiveBindings();
  const overrides = useSettings((s) => s.settings.shortcuts.bindings);
  const [capture, setCapture] = useState<Capture | null>(null);
  const captureButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const { mod, alt } = modifierLabels();

  const phase = capture?.phase;
  useEffect(() => {
    if (phase === "conflict") replaceButton.current?.focus();
  }, [phase]);

  /** Ends a conflict and puts focus back on the row's chord button. */
  const endConflict = () => {
    captureButton.current?.focus();
    setCapture(null);
  };

  const onCaptureKey = (id: ShortcutId, e: KeyboardEvent) => {
    // Every key belongs to the capture: neither the webview nor the window shortcuts may act.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setCapture(null);
    const chord = chordFromEvent(e);
    if (chord === null) return;
    if (!isBindable(chord)) {
      return setCapture({
        id,
        phase: "listening",
        error: `Add ${mod} or ${alt}, or use a function key.`,
      });
    }
    const keys = chordToString(chord);
    if (keys === effective[id]) return setCapture(null);
    const other = SHORTCUTS.find((s) => effective[s.id] === keys);
    if (other !== undefined)
      return setCapture({ id, phase: "conflict", chord: keys, otherId: other.id });
    commit({ ...overrides, [id]: keys });
    setCapture(null);
  };

  const reset = (id: ShortcutId) => {
    const next = { ...overrides };
    delete next[id];
    commit(next);
  };

  return (
    <Section id="shortcuts" name="Keyboard shortcuts">
      {SHORTCUT_GROUPS.map((group) => (
        <table key={group} className={dialogStyles.table}>
          <caption className={dialogStyles.caption}>{group}</caption>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Shortcut</th>
              <td />
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => {
              const mine = capture?.id === s.id ? capture : null;
              const listening = mine?.phase === "listening";
              const keys = effective[s.id];
              return (
                <Fragment key={s.id}>
                  <tr>
                    <td>{s.label}</td>
                    <td>
                      <button
                        type="button"
                        ref={mine !== null ? captureButton : undefined}
                        aria-label={`Change shortcut for ${s.label}`}
                        className={styles.chord}
                        onClick={() => setCapture({ id: s.id, phase: "listening" })}
                        onKeyDown={listening ? (e) => onCaptureKey(s.id, e) : undefined}
                        onBlur={listening ? () => setCapture(null) : undefined}
                      >
                        {listening ? (
                          "Press keys…"
                        ) : (
                          <KeyParts
                            parts={
                              mine !== null
                                ? formatKeyParts(mine.chord)
                                : keys === null
                                  ? null
                                  : formatKeyParts(keys)
                            }
                          />
                        )}
                      </button>
                    </td>
                    <td>
                      {mine?.phase === "conflict" ? (
                        <span className={styles.row}>
                          <span className={styles.conflict}>
                            Already used by {shortcut(mine.otherId).label}
                          </span>
                          <button
                            type="button"
                            ref={replaceButton}
                            onClick={() => {
                              commit({ ...overrides, [s.id]: mine.chord, [mine.otherId]: null });
                              endConflict();
                            }}
                          >
                            Replace
                          </button>
                          <button type="button" onClick={endConflict}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        s.id in overrides && (
                          <button
                            type="button"
                            aria-label={`Reset ${s.label} to default`}
                            title={`Reset to ${formatKeys(s.keys)}`}
                            onClick={() => reset(s.id)}
                          >
                            Reset
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                  {mine?.phase === "listening" && mine.error !== undefined && (
                    <tr>
                      <td colSpan={3}>
                        <p role="alert" className={styles.error}>
                          {mine.error}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ))}
      <p role="status" className={styles.hint}>
        {phase === "listening" ? LISTENING : ""}
      </p>
      <p className={styles.hint}>
        Press a key combination with {mod} or {alt}, or a function key. Changes apply at once.
      </p>
      <div className={styles.row}>
        <button
          type="button"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => commit({})}
        >
          Reset all to defaults
        </button>
      </div>
    </Section>
  );
}
