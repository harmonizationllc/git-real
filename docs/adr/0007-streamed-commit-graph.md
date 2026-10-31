# ADR 0007 — Streamed commit graph with derived lanes

- Status: Accepted
- Date: 2026-10-31
- Epic: GR-1 / Story: GR-27 "Commit graph at 1M+ commits: incremental walk and compact lane storage"
- Follows: ADR 0001 (hybrid git backend), ADR 0004 (budgets, R5 deferred this work)

## Context

GR-16 measured the Linux kernel (1,501,435 commits) on an i9-13900F: 41 s to build the
graph, 8.8 GB resident after the build, and 2 GB more while paging. Two things caused it.
Every cached row materialised one pass-through edge per occupied lane column, so a kernel
row cost kilobytes, and the build held the session lock until the whole history was
walked, so nothing painted and no other command ran meanwhile.

A fact in libgit2 constrains the fix, verified in libgit2 1.9.7 `src/libgit2/revwalk.c`.
`git_revwalk_sorting` marks the walk `limited` for every sort mode except
`GIT_SORT_NONE`. `prepare_walk` then runs `limit_list` over the whole reachable history,
and `sort_in_topological_order` for `TOPOLOGICAL`, before it yields the first commit. No
libgit2 revwalk streams, and git's own incremental topological order needs generation
numbers from a commit-graph file that libgit2 does not expose. The builder therefore
traverses the history itself.

## Decision

- **D1 — Two-pass build on a background thread.** Each `RepoSession` owns a builder: a
  `std::thread` with its own `git2::Repository` on the same path (`Repository` is `Send`
  but not `Sync`). Core stays free of Tauri and tokio. Pass A is our own best-first
  traversal: a max-heap by committer time over the tips (HEAD plus every peeled branch,
  remote and tag ref), a `seen` map that doubles as the oid index, and one `find_commit`
  per commit. Each popped commit becomes a row, is laid out in lanes at once, and is
  published in sealed chunks. Date skew can pop a parent before its child, so the
  provisional layout ignores an already emitted parent and records that in a per-row
  bitmask that replay honours. Pass B sorts the collected rows in memory with Kahn's
  algorithm (`topo_order`): children before parents, newest committer time first among
  ready commits, ties to the earlier discovered row. That is the GR-8 ordering contract,
  not byte equality with libgit2's tie breaking. It then re-lays the lanes over the final
  order and publishes the result as complete. The sort is one uninterruptible in-memory
  call; the cancel flag is checked once per chunk before and after it. On first open
  the provisional chunks are still held by the published generation, so pass B clones
  their rows instead of moving them; when no reader or generation holds them they move.
- **D2 — Compact rows.** A cached row drops `lane` and `edges`. It keeps the oid, a boxed
  parent list, a boxed subject, the author time, an `Arc` to an author interned per
  distinct name and email, and a `u32` layout-skip mask. Ref labels live in one map per
  generation, and committer time lives in a build-time side array dropped after pass B. A
  unit test pins `size_of::<Row>()` at 80 bytes or less.
- **D3 — Lanes derived per page.** Rows live in immutable chunks of 500, the front end's
  page size. Each chunk stores the lane columns at its first row. Serving a page seeds a
  `LaneLayout` from that checkpoint and replays the layout up to the page's last row, at
  most three chunks because `count` is clamped to 1..=1000. Storage no longer depends on
  how many lanes a row sits among.
- **D4 — Snapshots, served-until-final rebuilds, generations.** The builder and session
  share one mutex-guarded state. Readers clone the `Arc`s they need and release the lock,
  so a page, a body search or a file-history scan never holds the session lock for its
  duration. While a generation is incomplete, `total` counts sealed chunks only, so every
  servable page is full and immutable. When a ref changes and a complete generation
  exists, it keeps serving, with `refreshing` true, until the new build is final. The
  final state keeps the generation number unless a reader observed the provisional one;
  then it takes a newer number so pages re-key. `log_summary` waits up to 150 ms
  (`FIRST_ANSWER_MS`) for a build, so repositories up to tens of thousands of commits
  answer complete in one call as before, and larger ones answer provisional while the
  front end polls. A 40-hex search is answered from the oid index.

File history pages with a cursor (`next_row`, `follow_path`, a 20,000-row scan budget per
call) so a call is bounded on any repository size. The bench gains `firstSummaryMs`,
`graphCompleteMs` and `rssAfterBuildMb`; the new budget is in the ADR 0004 amendment.

## Consequences

- A ref change still costs a full rebuild. It now runs in the background while the old
  generation serves.
- On first open, search and file history wait for a complete graph, and the UI says
  `Loading…` until then. After the first open a complete generation is always served.
- Two generations can be resident during a rebuild, about 250 MB extra on the kernel.
- The provisional layout may differ from the final one, so the viewport follows the top
  commit by oid across a generation change rather than by row number.
- The layout-skip mask covers a merge's first 32 parents, so a later octopus parent emitted
  before its merge draws a pass-through to the end of the provisional graph, never the final one.
- Pass B needs all rows in memory and its sort cannot be interrupted, so cancelling a
  superseded kernel build waits for the sort to finish.
- Ordering among equal committer times follows discovery order, so a test must not depend
  on a tie between equal times.

## Measured

Linux kernel fixture (`--commits 2000000`), `--no-assert`, backend at commit f439d9d:

| Measure                           | Before GR-27 | After GR-27 |
| --------------------------------- | -----------: | ----------: |
| Commits                           |    1,501,435 |   1,504,946 |
| Max lanes                         |            - |         702 |
| `openToFirstPageMs`               |       41,014 |         151 |
| `firstSummaryMs`                  |            - |         150 |
| `graphCompleteMs`                 |       41,014 |      27,197 |
| `rssAfterBuildMb`                 |        8,798 |       1,025 |
| `rssGrowthMb` (paging)            |        2,055 |          15 |
| `pageAllMs` (3,010 pages of 500)  |            - |      13,013 |

The before column is the GR-16 build time, which was also its time to first page. The
fixture grew by 3,511 commits between the two runs. Swap did not change during the run.
The owner's 3 s first-page and no-swap pass mark is met on the backend; the desktop walk
on COSMIC is the owner's.
