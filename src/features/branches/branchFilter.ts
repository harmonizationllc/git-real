import type {
  BranchList,
  Issue,
  LinkedWorktree,
  PullRequest,
  StashEntry,
  TagEntry,
} from "../../lib/ipc";

/** A case-insensitive substring test for `query`, or null when the query is blank. */
function matcher(query: string): ((s: string) => boolean) | null {
  const q = query.trim().toLowerCase();
  return q === "" ? null : (s) => s.toLowerCase().includes(q);
}

/** Whether `query` filters anything; the refs column's single rule. */
export const isFiltering = (query: string): boolean => matcher(query) !== null;

/**
 * Case-insensitive substring filter: local branches match on their name, remote branches on
 * `remote/name`. Groups keep their order and stay present when empty; a blank query returns the
 * input itself.
 */
export function filterBranches(list: BranchList, query: string): BranchList {
  const hit = matcher(query);
  if (hit === null) return list;
  return {
    head: list.head,
    local: list.local.filter((b) => hit(b.name)),
    remotes: list.remotes.map((g) => ({
      ...g,
      branches: g.branches.filter((b) => hit(`${b.remote}/${b.name}`)),
    })),
  };
}

/** Tags whose name contains the query, case-insensitively, in their order; a blank query returns `tags` itself. */
export function filterTags(tags: TagEntry[], query: string): TagEntry[] {
  const hit = matcher(query);
  return hit === null ? tags : tags.filter((t) => hit(t.name));
}

/** Stashes whose message or parsed branch contains the query; a blank query returns `entries` itself. */
export function filterStashes(entries: StashEntry[], query: string): StashEntry[] {
  const hit = matcher(query);
  return hit === null ? entries : entries.filter((e) => hit(e.message) || hit(e.branch ?? ""));
}

/** Worktrees whose checked-out branch (when on one) or path contains the query; a blank query returns `list` itself. */
export function filterWorktrees(list: LinkedWorktree[], query: string): LinkedWorktree[] {
  const hit = matcher(query);
  if (hit === null) return list;
  return list.filter((w) => (w.head?.kind === "branch" && hit(w.head.name)) || hit(w.path));
}

/** Pull requests whose title or `#number` contains the query; a blank query returns `items` itself. */
export function filterPullRequests(items: PullRequest[], query: string): PullRequest[] {
  const hit = matcher(query);
  return hit === null ? items : items.filter((p) => hit(p.title) || hit(`#${p.number}`));
}

/** Issues whose title or `#number` contains the query; a blank query returns `items` itself. */
export function filterIssues(items: Issue[], query: string): Issue[] {
  const hit = matcher(query);
  return hit === null ? items : items.filter((i) => hit(i.title) || hit(`#${i.number}`));
}
