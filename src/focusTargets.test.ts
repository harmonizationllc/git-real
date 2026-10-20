import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  "src/features/merge/rebase/RebaseDialog.tsx": 1,
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });

/** The opening tag text around a tabIndex={-1}, skipping `>` inside {...} expressions. */
const tagAround = (src: string, at: number): string => {
  const start = src.lastIndexOf("<", at);
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
  const found = sources("src").flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(/tabIndex=\{-1\}/g)].map((m) => ({
      file: file.split("\\").join("/"),
      tag: tagAround(src, m.index),
    }));
  });
  const unmarked = found.filter((f) => !f.tag.includes("data-focus-target"));

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
    expect(found.length - unmarked.length).toBeGreaterThanOrEqual(8);
  });
});
