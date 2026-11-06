import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(relative(SRC, full));
  }
  return out;
}

// Imports omit the code extension, so `branchTree.ts` and `BranchTree.tsx`
// are the same module to a case-insensitive filesystem.
function moduleKey(path: string): string {
  return path.replace(/\.(tsx?|jsx?)$/, "").toLowerCase();
}

describe("source file names", () => {
  it("never differ only by case (Windows and macOS resolve them as one file)", () => {
    const groups = new Map<string, string[]>();
    for (const path of walk(SRC)) {
      const key = moduleKey(path);
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    const collisions = [...groups.values()].filter((paths) => paths.length > 1);
    expect(collisions).toEqual([]);
  });
});
