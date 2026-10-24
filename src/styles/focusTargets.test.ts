import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The tabIndex={-1} elements that are NOT programmatic focus fallbacks: dialog boxes and the
// ContextMenu container and items. They keep their own focus styling, so they must not carry
// data-focus-target (see ConfirmDialog.test.tsx). Anything else with tabIndex={-1} is a
// useRestoreFocus/ContextMenu fallback and needs the attribute for the global focus ring rule.
const ALLOWED_WITHOUT_ATTRIBUTE: Record<string, number> = {
  "src/components/ContextMenu.tsx": 2,
  "src/components/ConfirmDialog.tsx": 1,
  "src/components/PromptDialog.tsx": 1,
  "src/features/stash/StashDialog.tsx": 1,
  "src/features/hosting/AccountsDialog.tsx": 1,
  "src/features/hosting/ConnectAccountDialog.tsx": 1,
  "src/features/hosting/CreatePullRequestDialog.tsx": 1,
  "src/features/remotes/CredentialDialog.tsx": 1,
  "src/features/remotes/RemotesDialog.tsx": 1,
  "src/features/remotes/SetUpstreamDialog.tsx": 1,
  "src/features/tags/CreateTagDialog.tsx": 1,
  "src/features/merge/rebase/RebaseDialog.tsx": 1,
};

// Imperative forms (el.tabIndex = -1, setAttribute) and spread props are out of scope: the
// convention is declarative JSX.
const TAB_INDEX = /tabIndex=(?:\{\s*-1\b|"-1"|'-1')/g;
const FOCUS_TARGET_ATTR = /(?:^|\s)data-focus-target(?![\w-])/;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
      return /\.[jt]sx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
    })
    .sort();

/** Index of the "<" opening the tag that contains `at`, ignoring "<" inside {...} and quotes. */
const tagStart = (src: string, at: number): number => {
  let depth = 0;
  let quote = "";
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "}") depth++;
    else if (c === "{") depth--;
    else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (depth === 0 && c === "<" && /[A-Za-z]/.test(src[i + 1] ?? "")) return i;
  }
  return 0;
};

/** The opening tag text around a tabIndex, skipping `>` inside {...} expressions. */
const tagAround = (src: string, at: number): string => {
  const start = tagStart(src, at);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
};

// Contract: every programmatic focus fallback carries data-focus-target, which the global ring
// rule keys on; only the allowlisted dialogs and menus use tabIndex={-1} without it.
describe("focus target convention", () => {
  const found = sources(join(__dirname, "..")).flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(TAB_INDEX)].map((m) => ({
      file: `src/${relative(join(__dirname, ".."), file).split("\\").join("/")}`,
      tag: tagAround(src, m.index),
    }));
  });
  const unmarked = found.filter((f) => !FOCUS_TARGET_ATTR.test(f.tag));

  it("should mark every non-allowlisted tabIndex={-1} element as a focus target", () => {
    const offenders = unmarked
      .filter((f) => !(f.file in ALLOWED_WITHOUT_ATTRIBUTE))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("should keep the allowlisted dialogs and menus free of the attribute", () => {
    const counts: Record<string, number> = {};
    for (const f of unmarked) counts[f.file] = (counts[f.file] ?? 0) + 1;
    const marked = found.filter(
      (f) => f.file in ALLOWED_WITHOUT_ATTRIBUTE && !unmarked.includes(f),
    );
    expect([counts, marked]).toEqual([ALLOWED_WITHOUT_ATTRIBUTE, []]);
  });

  it("should find the focus targets it is meant to guard", () => {
    expect(found.length - unmarked.length).toBeGreaterThanOrEqual(9);
  });
});
