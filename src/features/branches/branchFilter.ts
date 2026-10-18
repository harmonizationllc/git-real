import type { BranchList } from "../../lib/ipc";

/**
 * Case-insensitive substring filter: local branches match on their name, remote branches on
 * `remote/name`. Groups keep their order and stay present when empty; a blank query returns the
 * input itself.
 */
export function filterBranches(list: BranchList, query: string): BranchList {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  const hit = (s: string) => s.toLowerCase().includes(q);
  return {
    head: list.head,
    local: list.local.filter((b) => hit(b.name)),
    remotes: list.remotes.map((g) => ({
      ...g,
      branches: g.branches.filter((b) => hit(`${b.remote}/${b.name}`)),
    })),
  };
}
