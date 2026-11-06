/** A folder of branches or a single branch leaf in the slash-path tree. */
export type BranchNode<B> =
  | { kind: "folder"; name: string; path: string; children: BranchNode<B>[] }
  | { kind: "branch"; branch: B };

/** The last `/` segment of a branch name; the name itself when it has none. */
export function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

interface Level<B> {
  folders: Map<string, { name: string; path: string; level: Level<B> }>;
  branches: BranchNode<B>[];
}

const newLevel = <B>(): Level<B> => ({ folders: new Map(), branches: [] });

function flatten<B>(level: Level<B>): BranchNode<B>[] {
  const folders = [...level.folders.values()].map(({ name, path, level: sub }): BranchNode<B> => ({
    kind: "folder",
    name,
    path,
    children: flatten(sub),
  }));
  return [...folders, ...level.branches];
}

/**
 * Folders first then branches at every level, each in first-appearance order of the input.
 * `path` is the slash-joined folder prefix (`feature/ui`); `name` its last segment.
 */
export function buildBranchTree<B extends { name: string }>(
  branches: readonly B[],
): BranchNode<B>[] {
  const root = newLevel<B>();
  for (const branch of branches) {
    const parts = branch.name.split("/");
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let entry = level.folders.get(path);
      if (!entry) {
        entry = { name: parts[i], path, level: newLevel<B>() };
        level.folders.set(path, entry);
      }
      level = entry.level;
    }
    level.branches.push({ kind: "branch", branch });
  }
  return flatten(root);
}
