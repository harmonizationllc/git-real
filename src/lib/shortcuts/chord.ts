/** One keyboard chord: `[Mod+][Alt+][Shift+]<Key>` in canonical form. */
export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const PUNCTUATION_CODES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

const NAMED_KEYS = [
  "Enter",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

/** Every key token a chord may end with. */
const KEY_TOKENS: readonly string[] = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...NAMED_KEYS,
  ...Object.keys(PUNCTUATION_CODES),
];

/** The physical `e.code` for one key token, so chords work on any layout. */
export function codeForKey(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES[key] ?? key;
}

const KEY_BY_CODE = new Map<string, string>(KEY_TOKENS.map((key) => [codeForKey(key), key]));
const KEY_SET = new Set(KEY_TOKENS);
const MODIFIERS = ["Mod", "Alt", "Shift"] as const;

/** Parses a canonical chord string; `null` when malformed or outside the token set. */
export function parseChord(keys: string): Chord | null {
  const parts = keys.split("+");
  // A trailing `+` key is not in the token set, so splitting on `+` is unambiguous.
  const key = parts.pop() as string;
  if (!KEY_SET.has(key)) return null;
  let next = 0;
  for (const part of parts) {
    const index = MODIFIERS.indexOf(part as (typeof MODIFIERS)[number]);
    if (index < next) return null;
    next = index + 1;
  }
  return {
    mod: parts.includes("Mod"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    key,
  };
}

/** The canonical string for `chord`. */
export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("Mod");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(chord.key);
  return parts.join("+");
}

/** The chord a key event presses, read from the physical `e.code`; `null` for keys outside the set. */
export function chordFromEvent(e: KeyboardEvent | React.KeyboardEvent): Chord | null {
  const key = KEY_BY_CODE.get(e.code);
  if (key === undefined) return null;
  return { mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, key };
}

/** True when the chord carries `Mod` or `Alt`, or is a function key. */
export function isBindable(chord: Chord): boolean {
  return chord.mod || chord.alt || /^F\d{1,2}$/.test(chord.key);
}

export const MAC_LABELS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
export const PC_LABELS: Record<string, string> = { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" };

export function isMac(): boolean {
  return navigator.platform.startsWith("Mac");
}

/** The platform words for `Mod` and `Alt`, for copy. */
export function modifierLabels(): { mod: string; alt: string } {
  const labels = isMac() ? MAC_LABELS : PC_LABELS;
  return { mod: labels.Mod, alt: labels.Alt };
}
