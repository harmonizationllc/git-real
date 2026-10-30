# GR-32 — Case-only branch name collisions on case-insensitive filesystems

- Jira: GR-32 "Windows: branches differing only by case cannot coexist
  (case-insensitive NTFS loose refs)" (Task, relates to GR-24).
- Depends on: GR-7 (`create_branch`, `rename_branch`, `validate_branch_name`,
  `GitError::BranchExists`, inline error alerts), GR-20 (the `core-windows`
  CI job, the two `#[cfg(unix)]` gates this ticket removes), GR-39
  (`add_linked_worktree` reuses `new_branch_target`).
- Follows: ADR 0001 (local reads and ref writes with git2), the IPC seam
  rule, the 100 % front-end coverage gate, the project rule that
  `git-real-core` carries no platform-specific assumptions.
- Date: 2026-10-30. Decision taken in chat: the ticket's option (b), detect
  the collision up front and refuse with a dedicated error. Options (a)
  (clearer `BranchExists` message) and (c) (document only) are rejected.

## 1. Goal

On a repository whose filesystem does not distinguish case, creating or
renaming a branch to a name that differs only by case from an existing local
branch is refused before libgit2 touches the ref store, with an error that
names the branch it collides with and says why. On a case-sensitive
filesystem nothing changes: `Alpha` and `alpha` keep coexisting.

The two tests gated `#[cfg(unix)]` under this ticket in GR-20 are split so
the byte-order sort assertions run on every platform; only the case-only
pairs stay Unix-only.

### Non-goals

- Changing how branches are listed or sorted (byte order stays).
- Tags, remotes, stashes or file paths. Status entries that collide on a
  case-insensitive filesystem cannot exist there in the first place; that
  half of the ticket is a test artefact and needs no product change.
- Detecting collisions with refs that live only in `packed-refs`. Git
  itself allows those; we match git's behaviour, not improve on it.
- Any macOS-specific handling (macOS is not a target; owner, 2026-10-27).
  The detection below would cover it anyway because it is filesystem-based,
  not OS-based.

### Anti-goals

- Probing the filesystem ourselves (creating temp files with case variants).
  Git already records the answer; we read it.
- Platform `cfg` in `git-real-core` product code. The behaviour keys off
  repository configuration so it unit-tests on Linux.

## 2. Behaviour

### 2.1 Detection

A repository is treated as case-insensitive when its effective git config has
`core.ignorecase = true`. Git and libgit2 write that key at `init` and
`clone` time after probing the working directory's filesystem, so it is
`true` on NTFS and default APFS/HFS+ and absent or `false` on Linux. An unset
key means `false`.

### 2.2 Duplicate and collision check

The existing exact-duplicate pre-checks call `repo.find_branch(name, Local)`.
On NTFS that lookup opens the loose ref file, so `find_branch("alpha")`
succeeds when only `Alpha` exists; that is exactly the `BranchExists("alpha")`
the Windows probe reported. The check must therefore compare _names_, not
look a name up through the filesystem. (My call, prompted by the builder
check.)

A new private helper in `refs/mod.rs` replaces all three `find_branch`
pre-checks:

```
fn refuse_duplicate_branch(repo: &Repository, name: &str, keep: Option<&str>)
    -> Result<(), GitError>
```

- Iterates the local branches once (`repo.branches(Some(BranchType::Local))`).
  The names it yields are the ref store's exact spellings.
- An entry whose name equals `name` exactly returns `BranchExists(name)`.
  This runs on every platform, whatever `core.ignorecase` says.
- When `core.ignorecase` is `true`, an entry whose name is not `keep` and
  whose Unicode lowercase fold (`str::to_lowercase`) equals the fold of
  `name`, with a different exact spelling, returns `BranchCaseCollision`
  with `requested = name` and `existing` = that entry's exact name. (My
  call: Unicode folding is a close enough approximation of the NTFS and APFS
  tables; an exact replica of either is out of scope.)
- `keep` names a branch to skip in the case comparison only. `rename_branch`
  passes `Some(old)` so renaming a branch to a case variant of its own name
  (`alpha` → `Alpha`) is not reported as a collision with itself.
  `create_branch` passes `None`.
- Exact match is decided before the case comparison, so an exact duplicate
  always yields `BranchExists` and only a case-only duplicate yields the new
  error, on every platform.

### 2.3 Where it runs

- `new_branch_target` (used by `create_branch`, `create_and_checkout_branch`
  and, through it, by `add_linked_worktree` with a new branch): replaces the
  `find_branch` check, `keep = None`.
- `rename_branch`: replaces the `find_branch` check, `keep = Some(old)`.
- `add_linked_worktree` (`linked_worktrees/mod.rs`): its own `find_branch`
  pre-check ahead of `new_branch_target` is removed as redundant; the
  helper inside `new_branch_target` produces the same `BranchExists` for an
  exact duplicate. The existing linked-worktree test for that error keeps
  passing.
- Nowhere else. Checkout, delete and tag operations are untouched.

### 2.4 The error

Core:

```
#[error("a branch named {existing} already exists, and this repository's \
         filesystem does not distinguish {requested} from it by case")]
BranchCaseCollision { requested: String, existing: String },
```

Tauri `AppErrorKind` gains `BranchCaseCollision`, mapped one-to-one from the
core variant, serialised as `branchCaseCollision`. The front end adds the
kind to the `AppErrorKind` union in `src/lib/ipc/types.ts` and to the `KINDS`
record in `src/lib/ipc/errors.ts`. No dialog changes: the new-branch,
rename-branch and add-worktree dialogs already render `error.message` in
their inline alert, and the message carries everything the user needs.

### 2.5 Renaming only the case of a branch's own name

`rename_branch("alpha", "Alpha")` passes our check on every platform. Whether
libgit2's `Branch::rename(new, force = false)` then completes on NTFS is
pre-existing behaviour this ticket does not change: libgit2 may find the
branch's own loose file under the new spelling and refuse. A test for the
self-rename runs on every platform; the `core-windows` CI job is the only
place it can actually be verified. If that job shows a refusal, the builder
may first try passing `force = true` to libgit2 only when `old` and `new`
fold to the same string (the only ref that overwrite could touch is the
branch itself). If that also fails or looks unsafe, gate that single test
`#[cfg(unix)]` with a comment naming a new follow-up ticket and report it in
the final summary. It does not block this ticket.

## 3. Tests

Core tests that depend on `core.ignorecase` write it into the temp
repository's config **before** `RepoSession::open`, through a new fixture
variant in `branches.rs` (and a matching one in `linked_worktrees.rs`) that
takes the desired boolean; the existing `fixture()` keeps its current
behaviour. The helper reads the key through `repo.config()?.get_bool(..)` on
each call rather than caching it at open. (My call, prompted by the builder
check: it sidesteps any question of whether an open `Repository` sees config
written through another handle.) Tests are then deterministic on Linux and
Windows alike.

### 3.1 New tests, `crates/git-real-core/tests/branches.rs`

With `core.ignorecase = true` written to the fixture's repo config:

- `create_branch("Alpha")` then `create_branch("alpha")` returns
  `BranchCaseCollision { requested: "alpha", existing: "Alpha" }`.
- `create_branch("Alpha")` then `create_branch("Alpha")` still returns
  `BranchExists("Alpha")` (exact duplicate keeps its error).
- `rename_branch("zeta", "Alpha")` with `Alpha` present still returns
  `BranchExists("Alpha")`.
- `rename_branch("zeta", "ALPHA")` with `Alpha` present returns
  `BranchCaseCollision { requested: "ALPHA", existing: "Alpha" }`.
- `rename_branch("alpha", "Alpha")` is `Ok(())` and the branch list then
  contains `Alpha` and not `alpha` (runs everywhere; see §2.5).
- The collision check sees nested names: `feature/X` vs `feature/x`.

With `core.ignorecase = false` written explicitly, `#[cfg(unix)]`:

- `create_branch("Alpha")` then `create_branch("alpha")` both succeed and
  both appear in the list (proves the check is off on case-sensitive
  filesystems; Unix-only because on NTFS the files really collide).

`#[cfg(windows)]`, no config manipulation:

- A fresh `Repository::init` fixture has `core.ignorecase = true`, and
  `create_branch("Alpha")` then `create_branch("alpha")` returns
  `BranchCaseCollision`. This is the end-to-end proof on the real
  filesystem and runs in the `core-windows` CI job.

### 3.2 New test, `crates/git-real-core/tests/linked_worktrees.rs`

With `core.ignorecase = true`, `add_linked_worktree` with
`WorktreeBranch::New { name: "alpha" }` while `Alpha` exists returns
`BranchCaseCollision` and creates no folder. (Covers the shared path through
`new_branch_target`.)

### 3.3 Split the two gated tests

`branches.rs`:

- `list_sorts_local_branches_by_name_in_byte_order` loses its `#[cfg(unix)]`
  gate and the GR-32 comment. Its names become `zeta`, `Beta`, `alpha` (byte
  order puts `Beta` before `alpha`, which is the assertion that matters) plus
  the fixture's head branch.
- New `#[cfg(unix)]` test `list_sorts_case_only_variants_in_byte_order` with
  `Alpha` and `alpha`, commented as Unix-only because the two cannot coexist
  on a case-insensitive filesystem (§2 refuses them there).

`status.rs`:

- `status_entries_sorted_bytewise_with_mixed_case_and_nesting` loses its gate
  and comment. Its files become `b.txt`, `a/b.txt`, `a.txt`, `a-b.txt`,
  `B/z.txt`; expected order `B/z.txt`, `a-b.txt`, `a.txt`, `a/b.txt`, `b.txt`.
- New `#[cfg(unix)]` test `status_entries_sort_case_only_variants_bytewise`
  with `B.txt`/`b.txt` and `A/z.txt`/`a/z.txt`, commented as Unix-only
  because the filesystem cannot hold both spellings.

### 3.4 Tauri and front end

- `src-tauri/src/error.rs`: the mapping `GitError::BranchCaseCollision` →
  `AppErrorKind::BranchCaseCollision`, covered by whatever test pattern the
  file's existing mappings use (if none exists, no new test is required for
  a one-line match arm).
- `src/lib/ipc/types.ts` and `src/lib/ipc/errors.ts`: add
  `branchCaseCollision`. The `Record<AppErrorKind, true>` table fails to
  type-check if either side is missing, which is the test.

### 3.5 Housekeeping

- Remove the two `// GR-32` comments from the test files.
- `docs/superpowers/specs/2026-10-27-gr20-tools-hardening-design.md` §6.1
  line "GR-32: NTFS loose refs and file names are case-insensitive" stays as
  a historical note; do not edit older specs.

## 4. Verification

- `cargo test -p git-real-core` (via `--manifest-path` from the worktree)
  and `cargo clippy --workspace -- -D warnings` green locally.
- `npm run typecheck`, `npm run lint`, `npm test` green with coverage at 100 %.
- Push the branch; the `core-windows` CI job must run the whole crate with
  the two formerly gated sort tests now included and the `#[cfg(windows)]`
  collision test passing. Report the run URL in the Jira summary comment.

## 5. Left to the builder

- Exact test names beyond those given, the shape of the `core.ignorecase`
  fixture variants, and whether the helper lives next to
  `validate_branch_name` or beside `new_branch_target`.
- Wording of code comments.

## 6. Follow-ups folded in (owner decision, 2026-10-30)

The owner ruled that nothing found while implementing a ticket is filed as a
follow-up ticket; it is fixed on the same branch. Two items from the final
review and the Windows CI comparison are therefore part of GR-32.

### 6.1 Every local branch lookup is case-exact

`find_local` is the only way product code looks up a local branch by name.
On a repository whose `core.ignorecase` is true it compares names by
iterating `repo.branches(Some(Local))`, exactly as the duplicate check does,
and reports `BranchNotFound` when no branch has that exact spelling. On a
case-sensitive repository it keeps using `find_branch`. The three remaining
direct `find_branch(.., Local)` calls move to `find_local`:

- `checkout_remote_branch`: a local branch with the exact name is switched
  to; without one, the new tracking branch is first checked with the
  duplicate helper, so a case variant is `BranchCaseCollision` instead of a
  `git switch -c` that git would refuse or that would land on the wrong
  branch.
- `merge::resolve_branch` (merge, rebase, fast-forward check): the local
  lookup is case-exact; the remote-tracking fallback is unchanged.
- `checkout_fetch_head` (`pr/<n>`): the existing-branch lookup is case-exact;
  when no exact branch exists the duplicate helper runs before any
  `git switch -C`, which on NTFS would otherwise reset a case variant.

Remote-tracking lookups (`remote_branch_ref`, the remote arm of
`resolve_branch`) are out of scope: they feed git full refnames and git
resolves them.

### 6.2 Canonical paths never carry the Windows verbatim prefix

`std::fs::canonicalize` on Windows returns `\\?\C:\...`. The git CLI rejects
such a path as a worktree target ("could not create leading directories of
'//?/C:/...': Invalid argument"), which is why 39 linked-worktree tests fail
on the Windows CI job today, and the app would hand the same paths back to
`git worktree remove`. Rule: `git-real-core` canonicalises every path through
`dunce::canonicalize` (already in `Cargo.lock` as a transitive dependency; a
no-op on non-Windows), wrapped in one crate-private `paths::canonical`. The
session root, every linked-worktree path, and the clone destination use it.
Tests compare against the same function through `common::canonical`. The
Windows job must then pass the whole core crate with no failures.
