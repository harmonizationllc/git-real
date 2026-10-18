# GR-6 — Commit and amend

- Status: Draft for user review
- Date: 2026-10-17
- Epic: GR-1 / Story: GR-6 "Commit and amend"
- Depends on: GR-4 (status, staging, watcher), GR-5 (Changes panel + detail
  pane layout in `RepoPane`)
- Follows: ADR 0001 (hybrid git backend), ADR 0002 (project structure)

## 1. Goal

Below the Changes panel the user writes a subject and an optional body, sees
who the commit will be attributed to, and commits the staged changes. The
same box amends the last commit, including its message. Signing happens
whenever the user's Git config asks for it.

### Acceptance criteria (from Jira GR-6)

1. Commit message editor with subject and body fields.
2. Subject line length warning past 72 characters.
3. Amend last commit, including editing its message.
4. Commit button is disabled when nothing is staged.
5. Author name and email are read from Git config and shown.
6. Signed commits (GPG/SSH) work when configured in Git config.

### Out of scope

- Merge-commit messages (`MERGE_MSG`) and conflict resolution (GR-10). A
  commit made while a merge is in progress still works; it uses the message
  typed in the box.
- Partial commits of unstaged files, "commit all", `--no-verify`, author
  override, co-author trailers, commit templates, message history.
- Pushing after committing (GR-7).
- Editing `user.name` / `user.email` from the app (GR-13 settings).

## 2. Decisions

- **Every commit shells out to `git commit`.** ADR 0001 sends signing to the
  CLI; routing unsigned commits through git2 and signed ones through the CLI
  would give two code paths with different behaviour (git2 runs no hooks and
  ignores `commit.gpgsign`). One path means hooks (`pre-commit`,
  `commit-msg`, `prepare-commit-msg`, `post-commit`), `commit.gpgsign`,
  `gpg.format`, `user.signingkey`, `gpg.ssh.*` and `commit.cleanup` all
  behave exactly as on the command line. The cost is that committing needs
  the git CLI, which the app already needs for clone; a missing CLI surfaces
  as the existing `gitCliMissing` error.
- **git2 does the reads around the commit**: author identity from config,
  the HEAD message for amend prefill, and the "is anything staged" check.
- **The message is passed on stdin with `-F -` and `--cleanup=whitespace`.**
  `whitespace` strips trailing whitespace and surplus blank lines but keeps
  lines starting with `#`, which `strip` (git's default for `-F`) would drop.
  `--amend` is added when amending; `--no-edit` is never needed because `-F`
  supplies the message. The child runs with `LC_ALL=C`,
  `GIT_TERMINAL_PROMPT=0` and `-C <workdir>`. No path arguments are passed
  and the message travels on stdin, so nothing the user types ever reaches
  the command line.
- **Signing prompts are the user's environment's job.** With no terminal,
  GPG needs a graphical pinentry and SSH signing needs an unlocked key or an
  `SSH_ASKPASS` program; both are standard on a desktop session. Failures
  come back as git's stderr and are shown verbatim.
- **Pre-checks run in core before spawning git**, so the common failures
  have stable error kinds instead of parsed stderr: empty subject →
  `emptyMessage`; nothing staged and not amending → `nothingToCommit`. Git
  remains the authority for everything else (unmerged files, hooks, signing,
  identity fallback).
- **Author identity missing disables the button in the UI** with the reason
  "Set user.name and user.email in your Git config". Git would otherwise
  either guess an identity from the hostname or fail; neither is what a GUI
  user wants.
- **Subject and body cross the IPC boundary as two strings** and core joins
  them (`subject`, blank line, `body`); core also splits the HEAD message
  for prefill. Message-format rules live in one place (Rust) and are pure
  unit tests.
- **Amend prefills from HEAD and restores the draft on untoggle.** Turning
  "Amend last commit" on stashes what was typed and loads HEAD's subject and
  body; turning it off restores the stash. Amending with nothing staged is
  allowed (message-only amend).
- **Drafts live in a Zustand store keyed by repo id**, not component state,
  so switching tabs keeps a half-written message. Not persisted: repo ids
  are per launch.
- **The 72-character limit is a warning, never a block.** The counter is
  always visible; past 72 it turns to the warning colour and a hint appears.
- **No new dependency** in Rust or the front end.

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  model/
    commit.rs          # CommitMessage, SigningFormat, CommitConfig, CommitOutcome
  commit/
    mod.rs             # impl RepoSession { commit_config, head_message, commit }
    message.rs         # pure: join(&CommitMessage) -> String, split(&str) -> CommitMessage
    git_commit.rs      # shell out: run(git, workdir, message, amend) -> Result<(), GitError>
```

`git_cli::locate` stays where it is (`remote::git_cli`); `commit` reuses it.

### 3.2 Types

```rust
// model/commit.rs — all serde camelCase
pub struct CommitMessage { pub subject: String, pub body: String }

pub enum SigningFormat { OpenPgp, X509, Ssh }   // "openPgp" | "x509" | "ssh"

pub struct CommitConfig {
    pub name: Option<String>,          // user.name
    pub email: Option<String>,         // user.email
    pub signing: Option<SigningFormat>,// Some when commit.gpgsign is true; gpg.format, default openpgp
}

pub struct CommitOutcome { pub oid: String, pub summary: String } // full hex oid, first subject line
```

### 3.3 Behaviour

- `commit_config()`: `repo.config()?.snapshot()`; `get_string("user.name")`
  / `"user.email"` (`None` on NotFound, error otherwise; empty strings count
  as `None`); `get_bool("commit.gpgsign")` defaulting to `false`;
  `get_string("gpg.format")` mapped case-insensitively, unknown values
  treated as `openpgp` (git's own fallback).
- `head_message()`: `Option<CommitMessage>`; `None` when HEAD is unborn.
  Message bytes decoded lossily. Returned as `split(message)`.
- `message::split(raw)`: subject = first line, trimmed; body = everything
  after the first line with leading blank lines and trailing whitespace
  removed. `message::join(m)`: subject with `\r`/`\n` replaced by spaces and
  trimmed; if the trimmed body is empty the result is `subject\n`, else
  `subject\n\nbody\n`.
- `commit(message, amend)`:
  1. `join`; if the subject is empty → `GitError::EmptyMessage`.
  2. If `!amend` and `repo.diff_tree_to_index(head_tree, None, None)` has no
     deltas (`head_tree` is `None` when HEAD is unborn, so an empty index
     also counts) → `GitError::NothingToCommit`.
  3. `git_cli::locate()?`, then `git_commit::run(&git, workdir, &raw, amend)`.
  4. Re-read HEAD with git2 and return `CommitOutcome`.
- `git_commit::run`: `git -C <workdir> commit --cleanup=whitespace -F -
[--amend]`, message written to stdin then stdin closed, stdout and stderr
  captured. Non-zero exit → `GitError::CommitFailed { code, stdout, stderr }`.
  The session mutex is held for the whole run (hooks included), which
  serialises operations on that repository as every other command does.

### 3.4 Errors

`GitError` gains `EmptyMessage`, `NothingToCommit`, and
`CommitFailed { code: Option<i32>, stdout: String, stderr: String }`.

### 3.5 Tests (`crates/git-real-core/tests/`)

- `commit_message.rs` (pure): split/join round trips, CRLF subject, body
  with `#` lines preserved, leading blank lines in body dropped, empty body
  yields a single trailing newline.
- `commit.rs` (skips when `git` is not on PATH, like `clone.rs`): first
  commit on an unborn HEAD; second commit; amend changes the message and
  keeps the parent; amend with nothing staged; `nothingToCommit`;
  `emptyMessage`; failing `pre-commit` hook → `CommitFailed` with the hook's
  stderr and no new commit; `commit_config` with and without identity and
  with `commit.gpgsign=true` + `gpg.format=ssh`; `head_message` unborn and
  multi-paragraph; non-UTF-8 message bytes do not panic.
  Fixtures set `user.name`/`user.email` in the repo-local config so the
  developer's global config is irrelevant.

## 4. Tauri app layer (`src-tauri/src`)

- `commands/commit.rs`: `get_commit_config(id) -> CommitConfig`,
  `get_head_message(id) -> Option<CommitMessage>`,
  `commit(id, message: CommitMessage, amend: bool) -> CommitOutcome`, each
  with an `_inner` function on `RepoRegistry` and a `run_blocking` wrapper,
  registered in `lib.rs`.
- `error.rs`: `AppErrorKind` gains `EmptyMessage`, `NothingToCommit`,
  `CommitFailed`. The `CommitFailed` message is the trimmed stderr; if that
  is empty, the trimmed stdout; if both are empty, "git commit failed with
  exit code N" / "git commit was terminated by a signal". Hook output is
  kept whole because that is what the user needs to read.
- Tests in `src-tauri/tests/commit_commands.rs`: config, head message,
  commit, amend, unknown repo id, error kind and message mapping.

## 5. Front end

### 5.1 IPC seam (`src/lib/ipc`)

- `types.ts`: `CommitMessage`, `SigningFormat = "openPgp" | "x509" | "ssh"`,
  `CommitConfig`, `CommitOutcome`; `AppErrorKind` gains `"emptyMessage"`,
  `"nothingToCommit"`, `"commitFailed"`.
- `errors.ts`: the three kinds added to `KINDS`.
- `commands.ts`: `getCommitConfig(id)`, `getHeadMessage(id)`,
  `commit(id, message, amend)`.

### 5.2 Query keys and store

- `queryKeys.commitConfig(id)` = `["repo", id, "commitConfig"]`,
  `queryKeys.headMessage(id)` = `["repo", id, "headMessage"]`. Both sit
  under the `repo(id)` prefix, so the watcher's `repo-changed` and every
  mutation's `onSettled` refresh them. `refetchOnWindowFocus` covers edits
  to the global `~/.gitconfig`, which the watcher does not see.
- New `src/lib/store/commitDraft.ts`:

```ts
interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  /** What was typed before amend was turned on; restored when it is turned off. */
  stash: { subject: string; body: string } | null;
}
interface CommitDraftState {
  drafts: Record<RepoId, CommitDraft>;
  draft(repoId): CommitDraft; // EMPTY_DRAFT when absent
  setSubject(repoId, subject): void;
  setBody(repoId, body): void;
  setAmend(repoId, on, head: CommitMessage | null): void; // stash/prefill or restore
  clear(repoId): void; // after a successful commit and on tab close
}
```

`App.tsx` calls `clear` on tab close next to the existing
`useWorkspace.getState().clear(id)`.

### 5.3 Files in `src/features/commit/`

| File                 | Role                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBJECT_LIMIT.ts`   | `export const SUBJECT_LIMIT = 72;`                                                                                                                                            |
| `useCommitConfig.ts` | `useQuery` on `getCommitConfig`                                                                                                                                               |
| `useHeadMessage.ts`  | `useQuery` on `getHeadMessage`                                                                                                                                                |
| `useCommit.ts`       | `useMutation` on `commit`; `onSuccess` clears the draft; `onSettled` invalidates `queryKeys.repo(repoId)`; exposes `commit(message, amend)`, `pending`, `error`, `clearError` |
| `commitGate.ts`      | pure `commitDisabledReason({ amend, subject, status, config }) → string \| null` (see 5.4)                                                                                    |
| `AuthorLine.tsx`     | "Name <email>" or "Author not configured"; signing badge "Signs with GPG" / "Signs with SSH" / "Signs with X.509"                                                             |
| `MessageEditor.tsx`  | subject `<input>` with counter `{n}/72` and warning past the limit, body `<textarea>`; Enter in the subject focuses the body; Ctrl+Enter in either submits                    |
| `CommitBox.tsx`      | container: reads draft, status, config, head message; renders `AuthorLine`, `MessageEditor`, the amend checkbox, the button, and an inline error (`RepoError` with Dismiss)   |
| `*.module.css`       | styles with the existing tokens                                                                                                                                               |

`RepoPane` wraps `ChangesPanel` and `CommitBox` in a `.sidebar` column
(panel scrolls, box pinned at the bottom with a top border), both keyed by
`tab.id`.

### 5.4 Behaviour and copy

- Labels: "Subject", "Body". Placeholders: "Summary of changes", "Optional
  longer description". Checkbox: "Amend last commit". Button: "Commit", or
  "Amend commit" when amending; "Committing…" while pending, with both
  fields, the checkbox and the button disabled.
- Counter past the limit: hint "Keep the subject at 72 characters or fewer",
  linked to the input with `aria-describedby`.
- `commitDisabledReason`, first match wins, shown as the button's `title`:
  1. status not loaded → "Loading…"
  2. config missing name or email → "Set user.name and user.email in your
     Git config"
  3. any conflicted entry → "Resolve conflicts before committing"
  4. `!amend` and no entry with `index !== null` → "Stage changes to commit"
  5. `subject.trim() === ""` → "Enter a commit subject"
- Amend checkbox is disabled with the title "No commit to amend" when
  `headMessage` is `null` (unborn HEAD).
- Success: draft cleared (amend off), queries refreshed; the Changes panel
  empties its Staged section by itself. No toast: the panel changing is the
  feedback.
- Failure: `RepoError` under the button with the message (hook output
  verbatim, multi-line preserved with `white-space: pre-wrap`) and Dismiss;
  the draft is kept.

### 5.5 Tests

- `commitDraft.test.ts`: amend on stashes and prefills, amend off restores,
  amend on with an empty head prefills nothing, clear, per-repo isolation.
- `commitGate.test.ts`: every reason in order, amend bypasses the staged
  check, conflicts win over staged.
- `useCommit.test.tsx`: success clears the draft and invalidates the repo
  prefix; failure keeps the draft and exposes `error`.
- `MessageEditor.test.tsx`: counter, warning at 73, Enter moves focus,
  Ctrl+Enter submits, disabled while pending.
- `AuthorLine.test.tsx`: identity, missing identity, each signing badge.
- `CommitBox.test.tsx`: full flow with the IPC seam mocked: disabled
  reasons, commit call shape `{ id, message: { subject, body }, amend }`,
  amend prefill from head message, error display and dismiss.
- `RepoPane.test.tsx`: renders the box below the panel.

## 6. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `npm test` (100 % coverage), `npm run lint`, `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture repository: author line
   shows the configured identity; button disabled with nothing staged; stage
   a file, type a 75-character subject and see the warning, commit, see the
   Staged section empty and the commit in `git log`; amend with a changed
   message and confirm `git log -1` shows it and the same parent; a failing
   `pre-commit` hook shows its output inline; with `gpg.format=ssh`,
   `user.signingkey` pointing at a public key and `commit.gpgsign=true`,
   commit and confirm `git log --show-signature -1` reports a good
   signature; set `user.name` to empty and see the disabled reason.
4. Jira GR-6 transitions to Done with the walk results and any decisions
   worth revisiting in a comment.
