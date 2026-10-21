import type { BranchList, TagEntry } from "../../lib/ipc";

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
