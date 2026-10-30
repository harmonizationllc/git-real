import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Settings, ShortcutKeycaps } from "../../lib/ipc";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  chordFromEvent,
  chordToString,
  formatKeyParts,
  formatKeys,
  isAltGraph,
  isBindable,
  isMac,
  keycapFromEvent,
  modifierLabels,
  shortcut,
} from "../../lib/shortcuts";
import type { ShortcutId } from "../../lib/shortcuts";
import { useEffectiveBindings, useKeycaps } from "../../lib/shortcuts/useShortcutKeys";
import { useSettings } from "../../lib/store/settings";
import { setShortcuts } from "../../lib/store/settingsActions";
import { Section } from "./Section";
import { KeyParts } from "./KeyParts";
import dialogStyles from "./ShortcutsDialog.module.css";
import styles from "./SettingsDialog.module.css";

const LISTENING = "Listening for a shortcut. Press Escape to cancel.";

/** The row capturing a chord: waiting for keys, or asking before taking another row's chord. */
type Capture =
  | { id: ShortcutId; phase: "listening"; error?: string }
  | {
      id: ShortcutId;
      phase: "conflict";
      chord: string;
      /** The chord's key token, whose keycap Replace learns. */
      key: string;
      otherId: ShortcutId;
      /** What the layout prints on the chord's key, learned when Replace saves. */
      keycap: string | null;
    };

/** Saves `next`, dropping bindings equal to the registry default so the file holds only overrides. */
function commit(next: Settings["shortcuts"]): void {
  const bindings = { ...next.bindings };
  for (const s of SHORTCUTS) {
    if (bindings[s.id] === s.keys) delete bindings[s.id];
  }
  setShortcuts({ bindings, keycaps: next.keycaps });
}

/**
 * `keycaps` with what the layout prints on the `key` token: an entry when it differs from the token,
 * none when it matches; unchanged when the press typed no usable character.
 */
function learn(keycaps: ShortcutKeycaps, key: string, keycap: string | null): ShortcutKeycaps {
  if (keycap === null) return keycaps;
  const next = { ...keycaps };
  if (keycap === key) delete next[key];
  else next[key] = keycap;
  return next;
}

/** The Keyboard shortcuts section: press a chord to rebind a row, resolve conflicts, reset. */
export function ShortcutSettings() {
  const effective = useEffectiveBindings();
  const overrides = useSettings((s) => s.settings.shortcuts.bindings);
  // Saves start from the valid entries, so a hand-edited bad keycap drops on the next save.
  const keycaps = useKeycaps();
  const [capture, setCapture] = useState<Capture | null>(null);
  const chordButtons = useRef(new Map<ShortcutId, HTMLButtonElement | null>());
  const replaceButton = useRef<HTMLButtonElement>(null);
  const { mod, alt } = modifierLabels();
  const descriptionId = useId();

  /** Puts focus on a row's chord button, e.g. after the control that had it goes away. */
  const focusChord = (id: ShortcutId) => chordButtons.current.get(id)?.focus();

  const phase = capture?.phase;
  useEffect(() => {
    if (phase === "conflict") replaceButton.current?.focus();
  }, [phase]);

  /** Ends a conflict and puts focus back on the row's chord button. */
  const endConflict = (id: ShortcutId) => {
    focusChord(id);
    setCapture(null);
  };

  /** Escape on Replace or Cancel cancels the conflict, without closing the Settings dialog. */
  const onConflictKey = (id: ShortcutId, e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    endConflict(id);
  };

  /** Sets the row to no chord; the keycaps describe keys, not shortcuts, so they stay. */
  const unbind = (id: ShortcutId) => commit({ bindings: { ...overrides, [id]: null }, keycaps });

  const onCaptureKey = (id: ShortcutId, e: KeyboardEvent) => {
    // Tab moves focus as usual; the blur that follows cancels the capture.
    if (e.key === "Tab") return;
    // Every other key belongs to the capture: neither the webview nor the window shortcuts may act.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setCapture(null);
    // AltGr types a character; like a modifier alone, it keeps listening.
    if (isAltGraph(e)) return;
    if (
      (e.key === "Backspace" || e.key === "Delete") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      unbind(id);
      return setCapture(null);
    }
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
    const keycap = keycapFromEvent(e, chord);
    if (keys === effective[id]) {
      // Re-pressing the chord on another layout corrects how it is shown, without rebinding.
      const learned = learn(keycaps, chord.key, keycap);
      if (learned[chord.key] !== keycaps[chord.key])
        commit({ bindings: overrides, keycaps: learned });
      return setCapture(null);
    }
    const other = SHORTCUTS.find((s) => effective[s.id] === keys);
    if (other !== undefined)
      return setCapture({
        id,
        phase: "conflict",
        chord: keys,
        key: chord.key,
        otherId: other.id,
        keycap,
      });
    commit({
      bindings: { ...overrides, [id]: keys },
      keycaps: learn(keycaps, chord.key, keycap),
    });
    setCapture(null);
  };

  const reset = (id: ShortcutId) => {
    const bindings = { ...overrides };
    delete bindings[id];
    commit({ bindings, keycaps });
    focusChord(id);
  };

  const resetAll = () => {
    commit({ bindings: {}, keycaps: {} });
    focusChord(SHORTCUTS[0].id);
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
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
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
                        ref={(el) => {
                          chordButtons.current.set(s.id, el);
                        }}
                        aria-label={`Change shortcut for ${s.label}`}
                        aria-describedby={`${descriptionId}-${s.id}`}
                        className={styles.chord}
                        onClick={(e) => {
                          // WebKit on macOS does not focus a button on click; the capture needs it.
                          e.currentTarget.focus();
                          setCapture({ id: s.id, phase: "listening" });
                        }}
                        onKeyDown={listening ? (e) => onCaptureKey(s.id, e) : undefined}
                        onBlur={listening ? () => setCapture(null) : undefined}
                      >
                        {listening ? (
                          "Press keys…"
                        ) : (
                          <KeyParts
                            parts={
                              mine !== null
                                ? formatKeyParts(mine.chord, learn(keycaps, mine.key, mine.keycap))
                                : keys === null
                                  ? null
                                  : formatKeyParts(keys, keycaps)
                            }
                          />
                        )}
                      </button>
                      <span id={`${descriptionId}-${s.id}`} hidden>
                        {keys === null ? "Unbound" : formatKeys(keys, keycaps)}
                      </span>
                    </td>
                    <td>
                      {mine?.phase === "conflict" ? (
                        <span
                          role="group"
                          aria-label="Shortcut conflict"
                          className={styles.row}
                          onKeyDown={(e) => onConflictKey(s.id, e)}
                        >
                          <span className={styles.conflict}>
                            Already used by {shortcut(mine.otherId).label}
                          </span>
                          <button
                            type="button"
                            ref={replaceButton}
                            onClick={() => {
                              commit({
                                bindings: {
                                  ...overrides,
                                  [s.id]: mine.chord,
                                  [mine.otherId]: null,
                                },
                                keycaps: learn(keycaps, mine.key, mine.keycap),
                              });
                              endConflict(s.id);
                            }}
                          >
                            Replace
                          </button>
                          <button type="button" onClick={() => endConflict(s.id)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className={styles.row}>
                          {keys !== null && (
                            <button
                              type="button"
                              aria-label={`Unbind ${s.label}`}
                              onClick={() => {
                                unbind(s.id);
                                focusChord(s.id);
                              }}
                            >
                              Unbind
                            </button>
                          )}
                          {s.id in overrides && (
                            <button
                              type="button"
                              aria-label={`Reset ${s.label} to default`}
                              title={`Reset to ${formatKeys(s.keys, keycaps)}`}
                              onClick={() => reset(s.id)}
                            >
                              Reset
                            </button>
                          )}
                        </span>
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
        Press a key combination with {mod} or {alt}, or a function key. Changes apply at once. The
        same settings file works on every platform: {mod} here is{" "}
        {isMac() ? "Ctrl on Linux and Windows" : "⌘ on a Mac"}.
      </p>
      <div className={styles.row}>
        <button
          type="button"
          disabled={Object.keys(overrides).length === 0 && Object.keys(keycaps).length === 0}
          onClick={resetAll}
        >
          Reset all to defaults
        </button>
      </div>
    </Section>
  );
}
