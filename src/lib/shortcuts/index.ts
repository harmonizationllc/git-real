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

/** The physical `e.code` expected for one key token, so chords work on non-Latin layouts. */
function expectedCode(token: string): string | null {
  if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (token === ",") return "Comma";
  if (token === "/") return "Slash";
  return token; // Enter, PageDown, PageUp
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

/** True when `e` is the exact chord for `id`, ignoring repeats, consumed and composing events. */
export function matchesShortcut(e: AnyKeyEvent, id: ShortcutId): boolean {
  if (e.repeat || e.defaultPrevented || isComposing(e)) return false;
  const parts = shortcut(id).keys.split("+");
  const token = parts[parts.length - 1];
  const wantMod = parts.includes("Mod");
  const wantShift = parts.includes("Shift");

  if ((e.ctrlKey || e.metaKey) !== wantMod) return false;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey) return false;

  const code = expectedCode(token);
  return e.key.toLowerCase() === token.toLowerCase() || (code !== null && e.code === code);
}

const MAC_LABELS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
const PC_LABELS: Record<string, string> = { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" };

function isMac(): boolean {
  return navigator.platform.startsWith("Mac");
}

/** Human labels for each part of a `keys` string, e.g. `["Ctrl","Shift","F"]` or `["⌘","⇧","F"]`. */
export function formatKeyParts(keys: string): string[] {
  const labels = isMac() ? MAC_LABELS : PC_LABELS;
  return keys.split("+").map((part) => labels[part] ?? part);
}

/** The parts joined with `+` (or nothing on macOS). */
export function formatKeys(keys: string): string {
  return formatKeyParts(keys).join(isMac() ? "" : "+");
}
