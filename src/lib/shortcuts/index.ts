import type { ShortcutBindings, ShortcutKeycaps } from "../ipc/types";
import {
  MAC_LABELS,
  PC_LABELS,
  chordToString,
  codeForKey,
  isAltGraph,
  isBindable,
  isKeyToken,
  isMac,
  parseChord,
} from "./chord";
import type { Chord } from "./chord";

export * from "./chord";

export type ShortcutId =
  | "palette"
  | "shortcuts"
  | "settings"
  | "openRepo"
  | "cloneRepo"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "fetch"
  | "pull"
  | "push"
  | "fileHistory"
  | "commit"
  | "linkIssue";

export type ShortcutGroup = "Application" | "Repository" | "Commit" | "Navigation";

export interface Shortcut {
  id: ShortcutId;
  keys: string;
  label: string;
  group: ShortcutGroup;
  when: "always" | "repo" | "editor";
}

/** The §7.1 registry, in table order. No shortcut is defined anywhere else. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", keys: "Mod+K", label: "Command palette", group: "Application", when: "always" },
  {
    id: "shortcuts",
    keys: "Mod+/",
    label: "Keyboard shortcuts",
    group: "Application",
    when: "always",
  },
  { id: "settings", keys: "Mod+,", label: "Settings", group: "Application", when: "always" },
  {
    id: "openRepo",
    keys: "Mod+O",
    label: "Open repository…",
    group: "Application",
    when: "always",
  },
  {
    id: "cloneRepo",
    keys: "Mod+Shift+O",
    label: "Clone repository…",
    group: "Application",
    when: "always",
  },
  {
    id: "closeTab",
    keys: "Mod+W",
    label: "Close repository tab",
    group: "Navigation",
    when: "repo",
  },
  {
    id: "nextTab",
    keys: "Mod+PageDown",
    label: "Next repository tab",
    group: "Navigation",
    when: "repo",
  },
  {
    id: "prevTab",
    keys: "Mod+PageUp",
    label: "Previous repository tab",
    group: "Navigation",
    when: "repo",
  },
  { id: "fetch", keys: "Mod+Shift+F", label: "Fetch", group: "Repository", when: "repo" },
  { id: "pull", keys: "Mod+Shift+L", label: "Pull", group: "Repository", when: "repo" },
  { id: "push", keys: "Mod+Shift+P", label: "Push", group: "Repository", when: "repo" },
  {
    id: "fileHistory",
    keys: "Mod+Shift+H",
    label: "File history…",
    group: "Repository",
    when: "repo",
  },
  { id: "commit", keys: "Mod+Enter", label: "Commit", group: "Commit", when: "editor" },
  {
    id: "linkIssue",
    keys: "Mod+Shift+I",
    label: "Link issue…",
    group: "Commit",
    when: "editor",
  },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "Application",
  "Repository",
  "Commit",
  "Navigation",
];

const BY_ID = new Map<ShortcutId, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  return BY_ID.get(id) as Shortcut;
}

export type EffectiveBindings = Record<ShortcutId, string | null>;

/**
 * Resolves the file's overrides against the registry; deterministic, never throws. Overrides are
 * assigned first, in registry order, each claiming its chord; then every id still unassigned takes
 * its default unless an override already claimed that chord, in which case it is unbound.
 */
export function resolveBindings(overrides: ShortcutBindings): EffectiveBindings {
  const resolved = {} as Record<ShortcutId, string | null | undefined>;
  const claimed = new Set<string>();
  for (const s of SHORTCUTS) {
    const override = overrides[s.id];
    if (override === undefined) continue;
    if (override === null) {
      resolved[s.id] = null;
      continue;
    }
    const chord = parseChord(override);
    if (chord === null || !isBindable(chord)) continue;
    const keys = chordToString(chord);
    if (claimed.has(keys)) continue;
    claimed.add(keys);
    resolved[s.id] = keys;
  }
  for (const s of SHORTCUTS) {
    if (resolved[s.id] !== undefined) continue;
    resolved[s.id] = claimed.has(s.keys) ? null : s.keys;
  }
  return resolved as EffectiveBindings;
}

let active: EffectiveBindings = resolveBindings({});

/** Replaces the bindings `matchesShortcut` reads. */
export function setActiveBindings(bindings: EffectiveBindings): void {
  active = bindings;
}

/** The effective chord for `id`, or `null` when unbound. */
export function activeKeys(id: ShortcutId): string | null {
  return active[id];
}

type AnyKeyEvent = KeyboardEvent | React.KeyboardEvent;

function isComposing(e: AnyKeyEvent): boolean {
  const native = (e as React.KeyboardEvent).nativeEvent as KeyboardEvent | undefined;
  return (
    (e as KeyboardEvent).isComposing === true ||
    native?.isComposing === true ||
    (e as KeyboardEvent).keyCode === 229 ||
    native?.keyCode === 229
  );
}

/** True when `e` is the exact effective chord for `id`, ignoring repeats, consumed and composing events. */
export function matchesShortcut(e: AnyKeyEvent, id: ShortcutId): boolean {
  if (e.repeat || e.defaultPrevented || isComposing(e)) return false;
  if (isAltGraph(e)) return false;
  const keys = activeKeys(id);
  if (keys === null) return false;
  const chord = parseChord(keys) as Chord;
  if ((e.ctrlKey || e.metaKey) !== chord.mod) return false;
  if (e.altKey !== chord.alt) return false;
  if (e.shiftKey !== chord.shift) return false;
  return e.code === codeForKey(chord.key) || e.key.toLowerCase() === chord.key.toLowerCase();
}

/**
 * The learned keycaps worth showing: entries whose key and keycap are both single-character key
 * tokens and differ. The file is hand-editable, so anything else is dropped on read.
 */
export function validKeycaps(keycaps: ShortcutKeycaps): ShortcutKeycaps {
  const single = (s: string) => s.length === 1 && isKeyToken(s);
  return Object.fromEntries(
    Object.entries(keycaps).filter(([key, cap]) => single(key) && single(cap) && key !== cap),
  );
}

/**
 * Human labels for each part of a `keys` string, e.g. `["Ctrl","Shift","F"]` or `["⌘","⇧","F"]`.
 * With `keycaps`, the key part shows the keycap learned for that physical key.
 */
export function formatKeyParts(keys: string, keycaps?: ShortcutKeycaps): string[] {
  const labels = isMac() ? MAC_LABELS : PC_LABELS;
  const parts = keys.split("+").map((part) => labels[part] ?? part);
  const keycap = keycaps?.[parts[parts.length - 1]];
  if (keycap !== undefined) parts[parts.length - 1] = keycap;
  return parts;
}

/** The parts joined with `+` (or nothing on macOS). */
export function formatKeys(keys: string, keycaps?: ShortcutKeycaps): string {
  return formatKeyParts(keys, keycaps).join(isMac() ? "" : "+");
}
