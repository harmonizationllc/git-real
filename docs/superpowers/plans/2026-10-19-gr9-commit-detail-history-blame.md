# GR-9 Commit Detail, File History and Blame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A selected commit lists its changed files and shows each one's diff; Ctrl+Shift+H opens a file picker whose choice puts the repo pane into file-history mode (the file's commits on the left, the diff on the right); a Blame toggle on the centre file view shows author, date and commit per line with links to the commit.

**Architecture:** `DiffScope` gains a `Commit(oid)` variant so the GR-5 diff pipeline serves commit diffs and image previews unchanged. A new `history` module in `git-real-core` adds `commit_files`, `file_history` (computed over the GR-8 log cache with rename following), `blame` (git2 `blame_file`, bounded) and `tracked_files`. The Tauri app exposes four commands. The front end adds `features/history/` views (commit files, history panel, blame view, file picker), a `FileHeader` with a Diff/Blame toggle on the centre view, and two workspace-store fields (`historyPath`, `centreView`) that `RepoPane` wires into the existing three columns.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), Tauri 2, React 19 + TypeScript, TanStack Query 5, `@tanstack/react-virtual` 3, Zustand 5, CodeMirror/Lezer highlighting, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-19-gr9-commit-detail-history-blame-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*` or `@tauri-apps/plugin-*` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio`; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency. Blame, history and tracked files are git2 reads; no CLI.
- `DiffScope::Commit(String)` serializes externally tagged: `{"commit": "<full hex>"}`; `"staged"` and `"unstaged"` are unchanged. `DiffScope` loses `Copy`.
- Commit scope diffs compare the first parent (empty tree for a root) to the commit, whole-commit with `find_similar(renames)`, exactly like the staged scope.
- File history walks the cached rows in order; a commit counts when the followed path's entry oid differs from the first parent's; renames switch the followed path; a merge equal to its first parent is skipped; stale generation → `LogStale`.
- Blame limits: `BLAME_MAX_BYTES = 4 * 1024 * 1024` → `TooLarge`; binary blob → new `GitError::BinaryFile(String)` ("{0} is a binary file") ↔ `AppErrorKind::BinaryFile` ↔ `"binaryFile"`.
- Serde: every new struct is `rename_all = "camelCase"`; oids are full hex strings; `Signature` is GR-8's.
- Query keys: immutable (`["repoImmutable", id, ...]`, `staleTime: Infinity`): `commitFiles(id, oid)`, `fileHistory(id, generation, path)`, `blameAt(id, path, oid)`. Under the repo prefix: `blameHead(id, path)` = `["repo", id, "blame", path]`, `trackedFiles(id)` = `["repo", id, "trackedFiles"]`.
- Constants: `MAX_PICKER_ROWS = 200`; blame row `estimateSize` 22, `overscan` 20; history rows use the graph's `ROW_HEIGHT` (28); `HIGHLIGHT_LIMIT` (20 000) applies to blame line count.
- Copy (verbatim): `Files (n)`, `Loading files…`, menu `File history`, `Blame at this commit`; header `History`, close `aria-label="Close file history"`, list `aria-label="File history"`, `Loading history…`, `No commits touch this file`; view radio group `aria-label="View"` with `Diff` and `Blame`; `History` button `aria-label="Show file history"`; blame table `aria-label="Blame"`, `Loading blame…`, hash button `aria-label="Open commit <7 hex>"`; picker title `File history`, input `aria-label="Find file"` placeholder `Type a file name`, list `aria-label="Files"`, `No matching files`; `No changes in <path>` for a commit-scope empty diff; section `aria-label="Changed files"`.
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` at 100 % coverage for `src/`, `npm run lint`, `npm run typecheck`.

## Review Focus

1. A file that was deleted and later re-added under the same path must list both lives, newest first, without the walk stopping at the deletion (Task 2 test `file_history_lists_a_file_deleted_then_re_added`).
2. A commit whose first parent is the empty tree (root) must diff every file as an addition and never fail on the missing parent (Task 1 tests `commit_scope_on_root_commit_is_all_additions`, `commit_files_on_root_lists_every_path_as_added`).
3. Blame of a CRLF file must line up hunks with the stripped lines so the counts still sum to the line total (Task 2 test `blame_strips_cr_and_hunks_cover_every_line`).
4. Switching the view toggle to Blame while an untracked working-tree file is selected must show the `pathNotFound` error with a working Dismiss that returns to the diff, not a blank centre (Task 5 test `BlameView error Dismiss returns to the diff view`, Task 4 test `DetailPane renders BlameView for an unstaged scope with a null oid`).
5. Ctrl+Shift+H while the picker, a prompt or a confirm dialog is open must not open a second picker (Task 6 test `shortcut is ignored while a dialog is open`).

---

### Task 1: Core — `DiffScope::Commit`, commit diffs, commit file content, `commit_files`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/model/diff.rs` (`DiffScope` gains `Commit(String)`; drop `Copy`)
- Create: `src-tauri/crates/git-real-core/src/model/history.rs` (`CommitFile`, `FileHistoryEntry`, `Blame`, `BlameHunk`)
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (`mod history; pub use history::{Blame, BlameHunk, CommitFile, FileHistoryEntry};`)
- Modify: `src-tauri/crates/git-real-core/src/diff/mod.rs` (`scoped_diff` Commit arm; `change_kind` becomes `pub(crate)`; scope passed by reference or cloned where it was copied)
- Modify: `src-tauri/crates/git-real-core/src/content.rs` (`file_content` Commit arms; `head_blob` → `tree_blob`)
- Create: `src-tauri/crates/git-real-core/src/history/mod.rs` (`commit_files`; `resolve_commit`, `first_parent_tree` helpers shared by Task 2)
- Modify: `src-tauri/crates/git-real-core/src/lib.rs` (`pub mod history;`)
- Modify: `src-tauri/crates/git-real-core/src/error.rs` (`BinaryFile(String)`, used by Task 2 but declared here so the model compiles once)
- Test: `src-tauri/crates/git-real-core/tests/diff.rs`, `tests/content.rs` (extend), `tests/history.rs` (create; Task 2 extends it)
- Test helper: `tests/common/mod.rs` gains `rename_fixture() -> (TempDir, PathBuf, Vec<git2::Oid>)`: commits `a.txt` ("one\n"), modifies it ("one\ntwo\n"), renames it to `b.txt` unchanged, modifies `b.txt` ("one\ntwo\nthree\n"); returns the four oids oldest first.

**Interfaces:**

- Consumes: `RepoSession::repo()`, `diff::change_kind`, `status::file_path`, `GitError::CommitNotFound`.
- Produces:

```rust
// model/diff.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope { Staged, Unstaged, Commit(String) }

// model/history.rs — Debug, Clone, PartialEq, Eq, Serialize, camelCase
pub struct CommitFile { pub path: String, pub old_path: Option<String>, pub change: ChangeKind }
pub struct FileHistoryEntry { pub oid: String, pub subject: String, pub author_name: String, pub author_email: String,
    pub author_time: i64, pub change: ChangeKind, pub path: String, pub old_path: Option<String> }
pub struct BlameHunk { pub start: u32, pub lines: u32, pub oid: String, pub author: Signature, pub summary: String }
pub struct Blame { pub oid: String, pub path: String, pub hunks: Vec<BlameHunk>, pub lines: Vec<String> }

// history/mod.rs
impl RepoSession {
    pub fn commit_files(&self, oid: &str) -> Result<Vec<CommitFile>, GitError>;
}
pub(crate) fn resolve_commit<'r>(repo: &'r Repository, oid: &str) -> Result<Commit<'r>, GitError>; // CommitNotFound
pub(crate) fn first_parent_tree<'r>(commit: &Commit<'r>) -> Result<Option<Tree<'r>>, GitError>;
pub(crate) fn commit_delta_diff<'r>(repo: &'r Repository, old: Option<&Tree<'r>>, new: &Tree<'r>, opts: Option<&mut git2::DiffOptions>) -> Result<git2::Diff<'r>, GitError>; // tree_to_tree + find_similar(renames)
```

- [ ] **Step 1: Write the failing tests** — `tests/diff.rs`: `commit_scope_on_root_commit_is_all_additions` (file_diff with `DiffScope::Commit(root)`: `change == Added`, every line an addition, `scope` echoed); `commit_scope_diffs_child_against_first_parent` (hunk shows `+two`); `commit_scope_on_merge_uses_first_parent` (`merge_fixture`: the merge's diff of the branch file shows the branch's addition); `commit_scope_rename_reports_old_path` (`rename_fixture` commit 3: `old_path == Some("a.txt")`, `change == Renamed`); `commit_scope_bad_oid_is_commit_not_found`; `commit_scope_untouched_path_is_no_changes`. `tests/content.rs`: `commit_scope_new_side_reads_the_commit_blob`, `commit_scope_old_side_reads_the_parent_blob`, `commit_scope_old_side_of_added_file_is_path_not_found`, `commit_scope_old_side_on_root_is_path_not_found`. `tests/history.rs`: `commit_files_on_root_lists_every_path_as_added`, `commit_files_lists_modified_deleted_and_renamed` (rename_fixture commit 3 → one `Renamed` with `old_path`), `commit_files_on_merge_compares_first_parent`, `commit_files_bad_oid_is_commit_not_found`, `commit_files_order_is_by_path`. Serde: `diff_scope_commit_serializes_tagged` (`{"commit":"<hex>"}` round trip).

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test diff --test content --test history` (from `src-tauri`); expected: compile errors on `DiffScope::Commit` and `commit_files`.

- [ ] **Step 3: Implement** — `scoped_diff`:

```rust
DiffScope::Commit(oid) => {
    let commit = history::resolve_commit(repo, oid)?;
    let new = commit.tree()?;
    let old = history::first_parent_tree(&commit)?;
    history::commit_delta_diff(repo, old.as_ref(), &new, Some(&mut o))
}
```

`commit_delta_diff` = `repo.diff_tree_to_tree(old, Some(new), opts)?` then `diff.find_similar(Some(DiffFindOptions::new().renames(true)))?`. `file_content`: `(Commit(oid), Old)` → `first_parent_tree` (`None` → `not_found`) → `tree_blob`; `(Commit(oid), New)` → `commit.tree()` → `tree_blob`. `tree_blob(&self, tree: &Tree, rel, max_bytes)` is the old `head_blob` body from `tree.get_path` on; `head_blob` keeps the HEAD resolution and calls it. `commit_files`: resolve, trees, `commit_delta_diff` with default options, then `diff.deltas().filter_map(|d| change_kind(d.status()).map(|change| CommitFile { path: file_path(&d.new_file()), old_path: Some(file_path(&d.old_file())).filter(|o| *o != path), change }))`. Everywhere `scope` was passed by `Copy`, pass `&scope` or `scope.clone()`; `FileDiff.scope` stores the clone.

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`, then `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(core): commit-scoped diffs, content and commit file list`.

---

### Task 2: Core — `file_history`, `blame`, `tracked_files`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/history/mod.rs` (three methods)
- Create: `src-tauri/crates/git-real-core/src/history/follow.rs` (`EntryMemo`, `rename_source`)
- Modify: `src-tauri/crates/git-real-core/src/log/mod.rs` (`log_cache(generation)` becomes `pub(crate)`; `CachedRow` fields readable by `history` via `pub(crate)` accessors or fields)
- Test: `src-tauri/crates/git-real-core/tests/history.rs` (extend)
- Test helper: `tests/common/mod.rs` gains `commit_binary(path, name, bytes, message) -> Oid` (writes bytes containing `\0`) and `commit_crlf(path, name, text, message)`.

**Interfaces:**

- Consumes: Task 1 helpers, `log::cache::{LogCache, CachedRow}` (`oid`, `parents`, `subject`, `author_name`, `author_email`, `author_time`), `GitError::{LogStale, UnbornHead, PathNotFound, TooLarge, BinaryFile}`.
- Produces:

```rust
impl RepoSession {
    pub fn file_history(&self, generation: u64, path: &str) -> Result<Vec<FileHistoryEntry>, GitError>;
    pub fn blame(&self, path: &str, oid: Option<&str>) -> Result<Blame, GitError>;
    pub fn tracked_files(&self) -> Result<Vec<String>, GitError>;
}
pub const BLAME_MAX_BYTES: u64 = 4 * 1024 * 1024;

// history/follow.rs
pub(crate) struct EntryMemo(HashMap<Oid /* tree */, Option<Oid /* entry */>>);
impl EntryMemo { pub(crate) fn entry(&mut self, repo: &Repository, tree_oid: Oid, path: &str) -> Result<Option<Oid>, GitError>; }
/// The old path when `commit` renamed something to `path`, via commit_delta_diff with renames.
pub(crate) fn rename_source(repo: &Repository, parent: Option<&Tree>, tree: &Tree, path: &str) -> Result<Option<String>, GitError>;
```

- [ ] **Step 1: Write the failing tests** — `tests/history.rs`: `file_history_lists_add_then_modify_newest_first` (two entries, `Modified` then `Added`); `file_history_follows_a_rename` (rename_fixture, path `b.txt`: four entries `Modified b.txt`, `Renamed b.txt old_path a.txt`, `Modified a.txt`, `Added a.txt`); `file_history_lists_a_file_deleted_then_re_added` (entries `Added`, `Deleted`, `Modified`, `Added`); `file_history_skips_a_merge_equal_to_first_parent`; `file_history_lists_a_merge_that_changed_the_file` (merge with a conflict resolution that edits the file → listed as `Modified`); `file_history_unknown_path_is_empty`; `file_history_stale_generation_is_log_stale`; `file_history_order_matches_graph` (indices of entries' oids in `log_page` ascending). Blame: `blame_two_commits_two_hunks` (lines `one`, `two` by different signatures via `signature_at`; hunks `start 1 lines 1`, `start 2 lines 1`, oids and `summary` match); `blame_at_older_commit` (`Some(first)` → one hunk, one line); `blame_defaults_to_head` (`oid == head oid`); `blame_strips_cr_and_hunks_cover_every_line` (CRLF file: lines have no `\r`, sum of hunk lines == `lines.len()`); `blame_missing_path_is_path_not_found`; `blame_binary_blob_is_binary_file`; `blame_oversize_blob_is_too_large` (4 MiB + 1 of `b"a\n"` repeated); `blame_bad_oid_is_commit_not_found`; `blame_unborn_head_is_unborn_head`; `blame_of_a_directory_is_path_not_found`. Tracked: `tracked_files_sorted_and_nested` (`b/c.txt`, `a.txt` → `["a.txt", "b/c.txt"]`); `tracked_files_skips_gitlink` (add a submodule entry through `index.add_frombuffer` with mode `0o160000`, or `repo.submodule` on a nested temp repo); `tracked_files_unborn_is_empty`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test history`.

- [ ] **Step 3: Implement** — `file_history`:

```rust
let cache = self.log_cache(generation)?;
let repo = self.repo();
let mut memo = EntryMemo::default();
let mut followed = path.to_owned();
let mut out = Vec::new();
for row in &cache.rows {
    let commit = repo.find_commit(row.oid)?;
    let tree = commit.tree()?;
    let parent_tree = first_parent_tree(&commit)?;
    let here = memo.entry(repo, tree.id(), &followed)?;
    let before = match &parent_tree { Some(t) => memo.entry(repo, t.id(), &followed)?, None => None };
    let (change, old_path) = match (here, before) {
        (Some(a), Some(b)) if a == b => continue,
        (Some(_), Some(_)) => (ChangeKind::Modified, None),
        (Some(_), None) => match rename_source(repo, parent_tree.as_ref(), &tree, &followed)? {
            Some(old) => (ChangeKind::Renamed, Some(old)),
            None => (ChangeKind::Added, None),
        },
        (None, Some(_)) => (ChangeKind::Deleted, None),
        (None, None) => continue,
    };
    out.push(FileHistoryEntry { oid: row.oid.to_string(), subject: row.subject.clone(), author_name: row.author_name.clone(),
        author_email: row.author_email.clone(), author_time: row.author_time, change, path: followed.clone(), old_path: old_path.clone() });
    if let Some(old) = old_path { followed = old; }
}
```

`EntryMemo::entry`: `tree.get_path(Path::new(path))` → `Ok(e)` → `Some(e.id())`, `NotFound` → `None`, other errors propagate; memoised per `(tree_oid)` — the key is the tree oid alone because `followed` only changes after a rename, so clear the memo whenever `followed` changes. `rename_source`: `commit_delta_diff(repo, parent, tree, None)` then find a delta with `status() == Renamed` and `new_file` path == `path`, return its old path. `blame`: resolve (`oid.map(resolve_commit)` or `repo.head()?.peel_to_commit()` with `UnbornBranch` → `UnbornHead`); `tree.get_path` (`NotFound` → `PathNotFound`); non-blob → `PathNotFound`; `odb.read_header` size → `TooLarge`; `find_blob`, `is_binary()` → `BinaryFile`; `BlameOptions::new().newest_commit(commit.id())`; `repo.blame_file`; map hunks; lines = `String::from_utf8_lossy(blob.content())`, `split('\n')`, drop one trailing empty element, `strip_suffix('\r')`. `tracked_files`: `head().peel_to_tree()` (`UnbornBranch` → empty vec), `tree.walk(TreeWalkMode::PreOrder, |root, entry| ...)` pushing `format!("{root}{name}")` for `Some(ObjectType::Blob)`, skipping `Commit`, then `sort()`.

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(core): file history over the log cache, blame and tracked files`.

---

### Task 3: Tauri app — `history` commands and `binaryFile` kind

**Files:**

- Create: `src-tauri/src/commands/history.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod history;`)
- Modify: `src-tauri/src/error.rs` (`AppErrorKind::BinaryFile`, `From` arm)
- Modify: `src-tauri/src/lib.rs` (register four commands)
- Test: `src-tauri/tests/history_commands.rs` (create), `src-tauri/tests/error.rs` (extend), `src-tauri/tests/worktree_commands.rs` (extend: diff command with a commit scope)

**Interfaces:**

- Consumes: Task 1–2 methods, `run_blocking`, `with_session`.
- Produces (command names and argument keys mirrored by the front end):

```rust
list_tracked_files(id)                                   -> Vec<String>
get_commit_files(id, oid: String)                        -> Vec<CommitFile>
get_file_history(id, generation: u64, path: String)      -> Vec<FileHistoryEntry>
get_blame(id, path: String, oid: Option<String>)         -> Blame
// each with pub fn <name>_inner(reg: &RepoRegistry, id: RepoId, ...) -> Result<_, AppError>
// AppErrorKind::BinaryFile serializes as "binaryFile"
```

- [ ] **Step 1: Write the failing tests** — `history_commands.rs`: each `_inner` round trip on `temp_repo_with_commit` (tracked lists the file; commit files lists it as `added`; history has one entry after `get_log_summary_inner`; blame has one hunk); `get_file_history_inner` with generation 99 → `LogStale`; `get_blame_inner` on a binary → kind `BinaryFile`; unknown repo id → `UnknownRepo` for all four. `error.rs`: `GitError::BinaryFile("x".into())` → `"binaryFile"` with message `x is a binary file`. `worktree_commands.rs`: `get_file_diff_inner` with `DiffScope::Commit(head_hex)` returns the diff; `serde_json::from_str::<DiffScope>(r#"{"commit":"abc"}"#)` deserializes.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real --test history_commands` (from `src-tauri`).

- [ ] **Step 3: Implement** — mirror `commands/log.rs`: `_inner` via `with_session`, `#[tauri::command] async fn` via `run_blocking`; register `commands::history::{list_tracked_files, get_commit_files, get_file_history, get_blame}` in `lib.rs`.

- [ ] **Step 4: Run to verify pass** — `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(app): history commands and binaryFile error kind`.

---

### Task 4: Front end foundations — seam, keys, store, scope helpers, text highlight, `FileHeader`, read-only commit diff

**Files:**

- Modify: `src/lib/ipc/types.ts` (`DiffScope`, `CommitFile`, `FileHistoryEntry`, `BlameHunk`, `Blame`, `binaryFile`), `src/lib/ipc/errors.ts` (`KINDS`), `src/lib/ipc/commands.ts` (four wrappers)
- Modify: `src/lib/query/keys.ts` (five keys)
- Modify: `src/lib/store/workspace.ts` (`historyPath`, `centreView`, `showHistory`, `setCentreView`, `clear`)
- Create: `src/features/diff/model/scope.ts`
- Modify: `src/features/diff/model/highlight.ts` (`highlightText`), create `src/features/diff/useTextHighlight.ts`
- Create: `src/features/diff/FileHeader.tsx` + `.module.css`
- Modify: `src/features/diff/DiffToolbar.tsx` (drop path and close; `CloseDiffButton` moves to `FileHeader.tsx` and is re-exported from `DiffToolbar.tsx` for existing imports), `src/features/diff/DetailPane.tsx`, `src/features/diff/HunkHeader.tsx`
- Modify: `src/features/worktree/ChangesPanel.tsx` only if `scope` typing breaks (it should not: it still passes string literals)
- Test: `types.test.ts`, `errors.test.ts`, `commands.test.ts`, `keys.test.ts`, `workspace.test.ts`, `scope.test.ts`, `highlight.test.ts`, `useTextHighlight.test.tsx`, `FileHeader.test.tsx`, `DiffToolbar.test.tsx`, `DetailPane.test.tsx`, `HunkHeader.test.tsx`

**Interfaces:**

- Consumes: Task 3 command names.
- Produces:

```ts
// types.ts
export type DiffScope = "staged" | "unstaged" | { commit: string };
export interface CommitFile { path: string; oldPath: string | null; change: ChangeKind }
export interface FileHistoryEntry { oid: string; subject: string; authorName: string; authorEmail: string; authorTime: number; change: ChangeKind; path: string; oldPath: string | null }
export interface BlameHunk { start: number; lines: number; oid: string; author: Signature; summary: string }
export interface Blame { oid: string; path: string; hunks: BlameHunk[]; lines: string[] }
// commands.ts
listTrackedFiles(id): Promise<string[]>; getCommitFiles(id, oid): Promise<CommitFile[]>;
getFileHistory(id, generation, path): Promise<FileHistoryEntry[]>; getBlame(id, path, oid: string | null): Promise<Blame>;
// keys.ts
commitFiles(id, oid) = ["repoImmutable", id, "commitFiles", oid]; fileHistory(id, generation, path) = ["repoImmutable", id, "fileHistory", generation, path];
blameAt(id, path, oid) = ["repoImmutable", id, "blame", path, oid]; blameHead(id, path) = ["repo", id, "blame", path]; trackedFiles(id) = ["repo", id, "trackedFiles"];
// workspace.ts
export type CentreView = "diff" | "blame";
historyPath: Record<RepoId, string | null>; centreView: Record<RepoId, CentreView>;
showHistory(repoId, path: string | null): void; setCentreView(repoId, view: CentreView): void;
// scope.ts
export const scopeId = (s: DiffScope) => typeof s === "string" ? s : `commit:${s.commit}`;
export const commitOf = (s: DiffScope) => typeof s === "string" ? null : s.commit;
export const isReadOnly = (s: DiffScope) => typeof s !== "string";
// highlight.ts / useTextHighlight.ts
export function highlightText(lines: string[], parser: Parser): (Token[] | null)[]   // tokenize(lines.join("\n"))
export function useTextHighlight(path: string, lines: string[] | undefined): (Token[] | null)[] | null
// FileHeader.tsx
export interface FileHeaderProps { path: string; oldPath?: string | null; view: CentreView; onViewChange(v: CentreView): void; onHistory(): void; onClose(): void }
export function FileHeader(props: FileHeaderProps): JSX.Element
export function CloseDiffButton({ onClick }): JSX.Element
// DetailPane.tsx — FileDetail keyed `${scopeId(file.scope)}:${file.path}`; renders <FileHeader> in every state;
//   centreView === "blame" → <BlameView repoId path oid={commitOf(scope)} /> (Task 5 component; this task renders a placeholder export from
//   src/features/history/BlameView.tsx declared here as `export function BlameView(props: { repoId: RepoId; path: string; oid: string | null }): JSX.Element` returning <div role="table" aria-label="Blame" /> so Task 5 fills it)
```

- [ ] **Step 1: Write the failing tests** — `types.test.ts` / `errors.test.ts`: `binaryFile` accepted by `isAppErrorKind`; `commands.test.ts`: each wrapper calls `invoke` with the exact name and `{ id, oid }` / `{ id, generation, path }` / `{ id, path, oid }` (`oid: null` passed through); `keys.test.ts`: five keys, `blameAt` starts with `repoImmutable`, `blameHead` and `trackedFiles` with `repo`; `fileDiff` with an object scope is stable; `workspace.test.ts`: `showHistory`, `setCentreView`, `clear` forgets both, `select` keeps `centreView`; `scope.test.ts`: three helpers for both forms; `highlight.test.ts`: `highlightText` returns one token array per line and empty arrays for blank lines; `useTextHighlight.test.tsx`: null while loading, tokens after, null for an unknown extension, null above `HIGHLIGHT_LIMIT` lines, no state update after unmount; `FileHeader.test.tsx`: path and `old → new`, radio group `View` with `Diff` checked, choosing `Blame` calls `onViewChange("blame")`, `History` button calls `onHistory`, close calls `onClose`; `DiffToolbar.test.tsx`: no path and no close rendered any more; `DetailPane.test.tsx`: header in loading, error, no-changes, binary and loaded states; commit scope renders no hunk buttons, no gutter select buttons and no discard dialog; `No changes in <path>` copy for a commit scope; `centreView === "blame"` renders the `Blame` table and does not call `getFileDiff`; `DetailPane renders BlameView for an unstaged scope with a null oid`; `HunkHeader.test.tsx`: `scope: { commit }` with `onAction` renders no buttons.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib src/features/diff`.

- [ ] **Step 3: Implement** — per the interfaces. `DetailPane`'s `FileDetail`:

```tsx
const view = useWorkspace((s) => s.centreView[repoId] ?? "diff");
const setView = useWorkspace((s) => s.setCentreView);
const showHistory = useWorkspace((s) => s.showHistory);
const readOnly = isReadOnly(file.scope);
const header = (oldPath: string | null = null) => (
  <FileHeader path={file.path} oldPath={oldPath} view={view} onViewChange={(v) => setView(repoId, v)}
    onHistory={() => showHistory(repoId, file.path)} onClose={close} />
);
const { diff, ... } = useFileDiff(repoId, view === "blame" ? null : file, ignoreWhitespace, maxLines);
if (view === "blame") return <div className={styles.root}>{header()}<BlameView repoId={repoId} path={file.path} oid={commitOf(file.scope)} /></div>;
```

Pass `selection`, `onHunkAction` only when `!readOnly`; render the discard `ConfirmDialog` only when `!readOnly`. `useFileDiff` already accepts `null` and disables the query.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): commit-scoped diffs, file header with view toggle, history store state`.

---

### Task 5: Front end — `src/features/history/` views

**Files:**

- Create: `src/features/history/model/fuzzy.ts`, `model/blameRows.ts`, `useCommitFiles.ts`, `useFileHistory.ts`, `useBlame.ts`, `useTrackedFiles.ts`, `CommitFiles.tsx`, `HistoryRow.tsx`, `FileHistoryPanel.tsx`, `BlameView.tsx` (replaces the Task 4 placeholder), `FilePickerDialog.tsx`, each with `.module.css` where styled
- Modify: `src/features/history/CommitSummary.tsx` (render `CommitFiles` after the message)
- Test: one `*.test.ts(x)` per file above; `CommitSummary.test.tsx` extended

**Interfaces:**

- Consumes: Task 4 types, keys, store, `useTextHighlight`, `LineContent`, `StatusBadge`, `ContextMenu`, `RepoError`, `relativeTime`/`fullDate`, `shortOid`, `ROW_HEIGHT`, `useLogSummary`, the `mockVirtualizer` test helper.
- Produces:

```ts
// model/fuzzy.ts
export function fuzzyMatch(query: string, path: string): number | null   // lower score is better; null = no match
export function rankFiles(query: string, paths: string[], limit: number): string[]
export const MAX_PICKER_ROWS = 200;
// model/blameRows.ts
export interface BlameRow { index: number; hunk: BlameHunk; firstOfHunk: boolean }
export function blameRows(blame: Blame): BlameRow[]
// hooks
useCommitFiles(repoId, oid): { files: CommitFile[] | undefined; isLoading; error: AppError | null; refetch() }
useFileHistory(repoId, generation: number | undefined, path): { entries: FileHistoryEntry[] | undefined; isLoading; error; refetch() }
useBlame(repoId, path, oid: string | null): { blame: Blame | undefined; isLoading; error; refetch() }
useTrackedFiles(repoId, open: boolean): { files: string[] | undefined; isLoading; error; refetch() }
// components
CommitFiles({ repoId, oid }); HistoryRow({ entry, now, selected, id, onSelect, onContextMenu? }); FileHistoryPanel({ repoId, path });
BlameView({ repoId, path, oid: string | null }); FilePickerDialog({ repoId, open, onPick(path), onCancel() })
```

- [ ] **Step 1: Write the failing tests** — `fuzzy.test.ts`: subsequence match, case-insensitive, basename substring ranks above a scattered match, no match → null, `rankFiles` tie-break by path, limit applied, empty query returns the first `limit`; `blameRows.test.ts`: rows per line, `firstOfHunk` on hunk starts, empty blame; hooks: keys and call shapes, `useFileHistory` disabled without a generation and `logStale` invalidates `queryKeys.log` once with no retry, `useBlame` picks `blameAt` vs `blameHead`, `useTrackedFiles` disabled when closed and `gcTime: 0`; `CommitFiles.test.tsx`: `Files (n)`, badge per kind, `old → new`, click calls `select` with `{ path, scope: { commit: oid } }`, `aria-current` on the selected file, menu `File history` calls `showHistory`, `Blame at this commit` selects and sets `centreView` to `blame`, loading, error with Retry; `HistoryRow.test.tsx`: fields, `aria-selected`, rename line; `FileHistoryPanel.test.tsx` (mocked virtualizer): header path and `title`, `Loading history…`, empty copy, rows, first entry auto-selected once (calls `selectCommit` and `select` with the entry's own `path`), click and Enter select, ArrowUp/Down/Home/End move and scroll, Escape and Close call `showHistory(repoId, null)`, error with Retry, stale invalidation; `BlameView.test.tsx`: `Loading blame…`, rows with hash button only on first lines, `aria-label="Open commit <7 hex>"`, `title` with full oid and summary, click calls `selectCommit`, `data-current` on the selected commit's hunk, line numbers, tokens applied, `BlameView error Dismiss returns to the diff view` (`setCentreView(repoId, "diff")`), Retry; `FilePickerDialog.test.tsx`: closed renders nothing, open focuses the input, filter ranks, `No matching files`, ArrowDown/Up move `aria-activedescendant`, Enter and click call `onPick`, Escape calls `onCancel`, cap at 200, loading and error; `CommitSummary.test.tsx`: renders the files section.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/history`.

- [ ] **Step 3: Implement** — `fuzzyMatch`: lowercase both; walk `path` finding each query char in order (first index ≥ previous + 1); no char → `null`; score = `lastIndex - firstIndex + 1`, minus 1000 when `basename.includes(query)`; empty query → 0. `rankFiles`: map to `[score, path]`, filter nulls, sort by score then `localeCompare`, slice. `FileHistoryPanel`: `useLogSummary` for the generation, `useFileHistory`, `useVirtualizer` as `GraphPanel`, listbox with `tabIndex={0}` and `aria-activedescendant`; auto-select in an effect keyed on the entries' identity when `selectedCommit` is not among them. `BlameView`: `useBlame`, `blameRows`, `useTextHighlight(path, blame?.lines)`, virtualized rows with `data-hunk-parity={i % 2}` from the hunk index and `data-current` when `hunk.oid === selectedCommit`. `FilePickerDialog`: copy `PromptDialog`'s focus/restore layout effect and backdrop; `rankFiles(query, files, MAX_PICKER_ROWS)`.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): commit files, file history panel, blame view and file picker`.

---

### Task 6: Front end — `RepoPane` wiring, shortcut, Changes menu item

**Files:**

- Modify: `src/app/RepoPane.tsx` (left column swap, keydown listener, picker), `src/features/worktree/ChangesPanel.tsx` (`File history` item)
- Test: `src/app/RepoPane.test.tsx`, `src/features/worktree/ChangesPanel.test.tsx`

**Interfaces:**

- Consumes: `FileHistoryPanel`, `FilePickerDialog`, `useWorkspace.historyPath/showHistory`.
- Produces: nothing new; `RepoPane` owns `const [picker, setPicker] = useState(false)`.

- [ ] **Step 1: Write the failing tests** — `RepoPane.test.tsx`: branches panel by default; `FileHistoryPanel` with the path when `historyPath` is set; Ctrl+Shift+H opens the picker (`role="dialog"` named `File history`); Meta+Shift+H too; `shortcut is ignored while a dialog is open` (an element with `role="dialog"` already in the document → no second dialog); picking calls `showHistory(tab.id, path)` and closes the picker; Escape closes it; the listener is removed on unmount. `ChangesPanel.test.tsx`: the context menu of a staged, an unstaged and an untracked row includes `File history`, enabled while `pending`, and it calls `showHistory(repoId, path)`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app/RepoPane src/features/worktree/ChangesPanel`.

- [ ] **Step 3: Implement** —

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== "h") return;
    if (document.querySelector('[role="dialog"]') !== null) return;
    e.preventDefault();
    setPicker(true);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

Left column: `{historyPath !== null ? <FileHistoryPanel repoId={tab.id} path={historyPath} /> : <BranchesPanel repoId={tab.id} />}`. Picker: `<FilePickerDialog repoId={tab.id} open={picker} onPick={(p) => { showHistory(tab.id, p); setPicker(false); }} onCancel={() => setPicker(false)} />`. `ChangesPanel.menuItems`: append `{ id: "history", label: "File history", onSelect: () => useWorkspace.getState().showHistory(repoId, row.entry.path) }` after the `pending` mapping so it is never disabled.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): file history mode, Ctrl+Shift+H picker and Changes menu entry`.

---

## Execution: batched agent cycles

Per `feedback-token-cost-batching`: three cycles, each running the mandatory team workflow once (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel → fix loop), then one final architect sign-off.

| Cycle | Tasks | Deliverable                                                                          |
| ----- | ----- | ------------------------------------------------------------------------------------ |
| 1     | 1–3   | Rust: commit scope, commit files, file history, blame, tracked files, commands       |
| 2     | 4     | Front-end foundations (seam, keys, store, scope helpers, FileHeader, read-only diff) |
| 3     | 5–6   | History views, picker, `RepoPane` wiring, Changes menu                               |

Dispatch count: 3 × 5 = 15 plus the final architect = 16, plus any fix passes. Models: architect and developer on the opus agent definitions, tester, coverage and reviewer on sonnet, passed explicitly on each dispatch. Agents write their reports to the scratchpad, not the main context.

## After the last task

1. Full gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` (100 %), `npm run lint`, `npm run typecheck`.
2. Acceptance walk from spec section 6 in the running app (`npm run tauri dev`, driven through the WebKit remote inspector per the `tauri-webview-automation` memory).
3. Merge `feature/gr-9-commit-detail-history-blame` into `main` with `--no-ff`; transition Jira GR-9 to Done with the walk results and follow-ups.
