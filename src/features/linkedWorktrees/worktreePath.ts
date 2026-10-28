/** The last non-empty segment of `path`, split on `/` or `\`. */
export function folderName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((s) => s !== "")
      .at(-1) ?? path
  );
}

/** `path` without its last segment (and any trailing separator); "" when it has no parent. */
export function parentFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? "" : trimmed.slice(0, cut);
}

/**
 * The add dialog's default folder: a sibling of the main worktree named
 * `<main folder>-<branch with "/" replaced by "-">`, or `-worktree` for a blank branch. The
 * separator is `\` when the main path has one, else `/`.
 */
export function defaultWorktreePath(mainPath: string, branch: string): string {
  const sep = mainPath.includes("\\") ? "\\" : "/";
  const suffix = branch.trim() === "" ? "worktree" : branch.trim().split("/").join("-");
  return `${parentFolder(mainPath)}${sep}${folderName(mainPath)}-${suffix}`;
}
