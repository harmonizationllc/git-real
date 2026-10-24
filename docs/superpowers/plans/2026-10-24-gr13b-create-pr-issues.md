# GR-13b Create Pull Request and Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a repository whose `origin` is on a connected GitHub, GitLab or Bitbucket account, the user opens a pull request for the current branch from a dialog (Push ▾ menu, the current branch's context menu, the Pull requests panel header) that publishes or pushes the branch first when needed; an **Issues** sidebar section lists the open issues; and a **#** button (or Ctrl/Cmd+Shift+I) in the commit editor opens a searchable issue picker that inserts `#<n>` at the cursor. This is slice 13b of GR-13 (ACs 4 and 6); 13c (clone repo browser) follows in its own plan.

**Architecture:** 13a's infrastructure carries everything: `Transport`/`FakeTransport`, `send_json` + the new `post_json`, `HostingStore`, `with_token`, `connected_repo`, `NetworkAuth`, `useNetworkAction`, `useRepoContext`, the `["hosting", …]` query keys. 13b adds three provider calls per host (repository info, issue search, create PR), one git2 read (the PR draft: commits ahead of the target), four commands, and three front-end surfaces (create dialog, Issues panel, issue picker) plus a minimal toast.

**Tech Stack:** Rust (git2 for the draft read, system git CLI for the push, `ureq` 3 behind `Transport`, `serde_json`), Tauri 2 commands through `run_blocking`, React 19 + TypeScript, TanStack Query 5, zustand, CSS modules, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-22-gr13-hosting-integration-design.md` (slice 13b: §2 row 13b, §4.2, §4.4 rows b, §5.3, §5.4, §6, §7, §8). The 13a plan `docs/superpowers/plans/2026-10-22-gr13a-hosting-accounts-prs.md` records the shared constraints and the implementation-time decisions this plan builds on.

## Global Constraints

- **Everything in the 13a plan's Global Constraints still holds** (test-first by the test role, the IPC seam, `git2` without network, no `tokio`/`reqwest`, `run_blocking`, the secrets rules, the `Authorization: Bearer` + per-provider headers, the HTTP status mapping, the `Token`/`Request` redaction, account-token git auth, the copy rules). This section lists only what 13b adds or changes.
- **No new dependencies.** No new `GitError` variants, `AppErrorKind`s or TS kinds: "issues disabled" is data (`HostedRepoInfo.issuesEnabled`), not an error.
- **Endpoints** (`{base}`, `{proj}`, `{owner}/{name}`, `{workspace}/{slug}` and percent-encoding as in 13a; `enc(x)` = `percent_encode(x)`, which leaves only `A-Za-z0-9-._~`, so a space is `%20`, `:` is `%3A`, `/` is `%2F`, `"` is `%22`):
  - repository info: GitHub `GET {base}/repos/{owner}/{name}`; GitLab `GET {base}/projects/{proj}`; Bitbucket `GET {base}/repositories/{workspace}/{slug}`
  - issues (page `{page}` of 50, newest update first; `{q}` is the user's query after `trim()`): GitHub `GET {base}/search/issues?q={enc("repo:{owner}/{name} is:issue is:open")}&sort=updated&order=desc&per_page=50&page={page}` and, when `{q}` is non-empty, the `q` value is `enc("repo:{owner}/{name} is:issue is:open {q}")` (the owner/name here are the raw segments, not percent-encoded twice); GitLab `GET {base}/projects/{proj}/issues?state=opened&order_by=updated_at&sort=desc&per_page=50&page={page}` plus `&search={enc(q)}` when non-empty; Bitbucket `GET {base}/repositories/{workspace}/{slug}/issues?pagelen=50&page={page}&sort=-updated_on&q={enc(filter)}` where `filter` is `(state="new" OR state="open")` and, when non-empty, `(state="new" OR state="open") AND title ~ "{q'}"` with `{q'}` = `{q}` with every `"` and `\` removed
  - create PR: GitHub `POST {base}/repos/{owner}/{name}/pulls` body `{"title","body","head":<source>,"base":<target>}`; GitLab `POST {base}/projects/{proj}/merge_requests` body `{"source_branch","target_branch","title","description"}`; Bitbucket `POST {base}/repositories/{workspace}/{slug}/pullrequests` body `{"title","description","source":{"branch":{"name":<source>}},"destination":{"branch":{"name":<target>}}}`. Each is built with `post_json` and parsed with the provider's existing PR wire struct and `convert`.
- **JSON mapping** (missing non-optional field → `HostingUnreachable { message: "unexpected response from <host>" }`):
  - repository info → `HostedRepoInfo { default_branch: Option<String>, issues_enabled: bool }`: GitHub `default_branch`, `has_issues`? (missing → true); GitLab `default_branch`? (null allowed), `issues_enabled` = `issues_access_level`? ≠ `"disabled"` **and** `issues_enabled`? ≠ `false` (both missing → true); Bitbucket `mainbranch.name`? (`mainbranch` null or missing → `None`), `has_issues`? (missing → true)
  - issue → `Issue { number, title, author, labels: Vec<String>, updated_at: i64, web_url }`: GitHub (`items[]` of the search body) `number`, `title`, `user.login`, `labels[].name`, `updated_at`, `html_url`, and any item that has a `pull_request` key is skipped; GitLab `iid`, `title`, `author.username`, `labels` (array of strings), `updated_at`, `web_url`; Bitbucket (`values[]`) `id`, `title`, `reporter.nickname` else `reporter.display_name` else `""` (`reporter` null allowed), `labels` = `[kind]` when `kind` is a string else `[]`, `updated_on`, `links.html.href`
- **Error message extraction** (`http.rs` `message`, first match wins; replaces 13a's order, everything after step 1 unchanged for bodies 13a tested): 1. `errors[0].message` string (GitHub 422 `Validation Failed` bodies); 2. `message` string, or `message` array of strings joined with `; ` (GitLab 409); 3. `error` string; 4. `error.message` string; 5. `HTTP <status>`. Then the token → `***`, then the 200-char cut, as before.
- **PR draft** (`RepoSession::pull_request_draft(target)`): `validate_branch_name(target)` first (`InvalidBranchName`); HEAD must be a branch (`UnbornHead` / `DetachedHead` from `head_branch`); `refs/remotes/origin/<target>` must exist, else `RevisionNotFound("origin/<target>")`; `ahead` = commits reachable from HEAD and not from the target, counted up to **1000** (saturating). `ahead == 1` → `title` = that commit's summary, `body` = its message after the first blank line with trailing whitespace trimmed (`""` when none); otherwise `title` = `humanize_branch(<head branch>)`, `body` = `""`. `humanize_branch`: the text after the last `/` (the whole name when there is none), runs of `-` and `_` → one space, trimmed, first character upper-cased: `feature/add-login` → `Add login`, `fix_typo` → `Fix typo`, `GR-13-hosting` → `GR 13 hosting`, `main` → `Main`.
- **Create command order:** push (when requested) **then** create; a failed push returns its error and sends no provider request. The push is `push_inner(reg, id, target, false, &request.branch, NetworkAuth::new(credentials, store))`, so a credential prompt and retry re-run the whole command (the push is idempotent).
- **Wire shapes (camelCase):** `HostedRepoInfo { defaultBranch, issuesEnabled }`; `Issue { number, title, author, labels, updatedAt, webUrl }`; `NewPullRequest { title, body, sourceBranch, targetBranch }`; `PullRequestDraft { title, body, ahead }`; `CreatePrRequest { branch, push: PushTarget | null, pr: NewPullRequest }`.
- **Commands** (JS args camelCase): `hosting_repo_info { id }` → `HostedRepoInfo`; `hosting_list_issues { id, query, page }` → `Issue[]`; `hosting_pull_request_draft { id, target }` → `PullRequestDraft`; `hosting_create_pull_request { id, request, credentials }` → `PullRequest`. `credentials` is `null` when absent.
- **TS wrappers:** `hostingRepoInfo(id)`, `hostingListIssues(id, query, page)`, `hostingPullRequestDraft(id, target)`, `hostingCreatePullRequest(id, request, credentials = null)`. Every wrapper sends every key, `null` included.
- **Query keys:** `queryKeys.hostingRepoInfo(id) = ["hosting", "repoInfo", id]`, `queryKeys.issues(id, query) = ["hosting", "issues", id, query]` (outside the repo prefix, as `pullRequests`), `queryKeys.prDraft(id, target) = ["repo", id, "prDraft", target]` (a git read; under the repo prefix). Connect/disconnect already invalidate `["hosting"]`.
- **Copy (verbatim; ‹…› are values):**
  - entry points: menu item `Create pull request…` (Push ▾, first item; current branch's context menu, after `Checkout`); PR panel header icon button text `+`, accessible name `Create pull request`
  - create dialog: title `Create pull request`; `Source` (read-only, shows ‹branch›); `Target` (select); `Title`; `Description`; notice `This branch isn't on the remote yet — it will be published first`; checkbox `Push ‹n› commits first` / `Push 1 commit first` (checked by default); `Cancel`; `Create pull request` / busy `Creating…`; loading `Loading…`; no targets `origin has no branches to target. Fetch first.`; not on a branch `Check out a branch to open a pull request.`; `Close`
  - toast: `Opened #‹n›`; action `Open in browser`; dismiss button accessible name `Dismiss notification`
  - issues panel: heading `Issues`, `Issues (‹n›)`, `Issues (‹n›+)`; `Connect your ‹Provider› account to see issues` + `Connect…`; `Token expired or revoked — reconnect` + `Reconnect`; `Loading issues…`; `Issues are turned off for this repository`; `No open issues`; `Show more` / `Loading…`; refresh `Refresh issues`; row `#‹n›` `‹title›`, `‹author›`, one badge per label; open icon `Open #‹n› in browser`; menu `Open in browser`, `Copy link`
  - issue picker: `#` button accessible name `Link issue`; dialog accessible name `Link issue`; search input `Search issues` with placeholder `Type to search`; `Searching…`; `No open issues match`; `Issues are turned off for this repository`; option text `#‹n› ‹title›`
- **`#n` insertion** (`insertIssueRef(value, start, end, ref)`): replaces `[start, end)` with `ref`, with a leading space when the character before `start` exists and is not whitespace, and a trailing space when the character at `end` exists and is not whitespace; `caret` is the index after everything inserted. The ref goes into the field (subject or body) that had focus when the picker was opened; the `#` button uses the last-focused field, body when none.
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing; from the root: `npm run test:coverage` at 100 % statements/branches/functions/lines, `npm run lint`, `npm run typecheck`, `npx prettier --check .`.

## Review Focus

1. **A provider rejection whose text is not a plain `message` string.** GitHub answers a duplicate PR with `{"message":"Validation Failed","errors":[{"message":"A pull request already exists for o:feat."}]}` and GitLab with `{"message":["Another open merge request already exists for this source branch: !5"]}`; the user must read the sentence, not `Validation Failed` or `HTTP 409` (Task 1 tests `github_validation_errors_surface_the_first_error_message` and `gitlab_array_messages_are_joined` in `hosting_http.rs`).
2. **Publish-first when the push fails or the sign-in is cancelled.** No PR is created, the dialog stays open with the push error (or silently after a cancel), and a retry pushes again (Task 2 test `create_with_a_failing_push_sends_no_provider_request`; Task 3 tests `keeps the dialog open with the push error` and `stays open without an error when the sign-in is cancelled` in `CreatePullRequestDialog.test.tsx`).
3. **A user query with quotes, `#`, `&` or spaces.** It must be percent-encoded into the URL on every provider, and on Bitbucket stripped of `"` and `\` so it cannot close the `title ~ "…"` literal (Task 1 test `issue_queries_are_percent_encoded_for_every_provider`).
4. **Inserting `#n` mid-word, at the end, or over a selection.** `Fix|login` → `Fix #12 login`; `Fix login|` → `Fix login #12`; a selected word is replaced; the caret lands after the inserted text; Ctrl/Cmd+Shift+I in the editor never reaches RepoPane's window handler (Task 4 tests in `issueRef.test.ts` and `MessageEditor.test.tsx`).
5. **Provider calls the user did not ask for.** Issues are keyed outside the repo prefix and are not requested while the section is collapsed, while the account needs a reconnect, or when the repository has issues turned off; the picker waits for the debounce (Task 4 tests `does not request issues while collapsed`, `does not request issues when they are turned off` in `IssuesPanel.test.tsx`, and `requests once after the debounce` in `IssuePicker.test.tsx`).

## Deviations and calls (decided here; the implementer does not reopen them)

- **One command pushes and creates.** `hosting_create_pull_request` runs the push (publish or push-ahead) and then the provider call, so the dialog runs a single `network.run(...)` and the GR-12 credential prompt covers the push. A failed create after a successful push leaves the branch published; the retry pushes a no-op and creates.
- **The draft is computed once**, for the default target, when the form mounts. Changing the target does not refill title or description (typed text is never overwritten).
- **Default target** = `HostedRepoInfo.defaultBranch` when `origin` has that branch; else `main` when present; else the first `origin` branch; with no `origin` branches the dialog shows the no-targets copy and only `Close`. Repository info that fails to load is shown inline (hosting copy) and the form still opens with the fallback target.
- **Publish when the upstream is not on `origin`** (no upstream, upstream on another remote, or upstream gone: `ahead === null`): the push is `{ kind: "setUpstream", remote: "origin", branch: <local name> }`, so the PR head is the local branch's name on `origin`. Otherwise the head is `tracking.upstream` minus `origin/`.
- **Pushing when behind** is not special-cased: the push fails with git's non-fast-forward error, shown inline, like a plain Push.
- **GitHub issues come from the search API** (`/search/issues` with `is:issue is:open`), both for the list and for the picker, so one endpoint serves both and pull requests never appear; GHE uses the same path under `/api/v3`.
- **Bitbucket shows the issue `kind` as its only label**; it has no labels.
- **Repository info is its own query** (`hosting_repo_info`), shared by the create dialog (default branch) and the Issues panel/picker (issues enabled). It is not folded into `RepoContext`, which stays a local-only read.
- **The Issues section starts collapsed** (`issuesCollapsed: true`, like Tags), so opening a repository costs no issues call until the user expands it.
- **Toasts are new, minimal infrastructure**: a zustand store in `src/lib/store/toasts.ts` and a `Toasts` component mounted once in `App.tsx`, auto-dismissed after 8 s, with one optional action. Nothing else moves to toasts in this slice.
- **The create dialog is owned by `RepoPane`** (boolean state) and reached through an `onCreatePullRequest: (() => void) | null` prop on `SyncToolbar`, `BranchesPanel` and `PullRequestsPanel`; `null` hides the menu items and disables the panel button. `RepoPane` computes it from `useRepoContext` (account present and not `needsReconnect`) and `branches.head.kind === "branch"`.
- **No draft-PR checkbox** and no reviewer/assignee fields (YAGNI; spec §5.3 lists none).
- **`PullRequestDraft` lives in `model/remote.rs`** beside `PushTarget` and is re-exported from `model`; the git work is `remote/pr_draft.rs` beside `pr_checkout.rs` (13a's deviation: PR git work lives in `remote/`, `hosting/` stays HTTP/JSON only).
- **`CreatePrRequest` is a command-layer struct** (`commands/hosting.rs`, `Deserialize`), bundling `branch`, `push` and `pr` so the inner function stays within clippy's seven-argument limit.

---

### Task 1: Core — repository info, issue search, create PR, error-message extraction, PR draft

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/hosting/model.rs` (`HostedRepoInfo`, `Issue`, `NewPullRequest`), `hosting/http.rs` (`message` order), `hosting/github.rs`, `hosting/gitlab.rs`, `hosting/bitbucket.rs` (`repo_info`, `list_issues`, `create_pull_request` each), `hosting/mod.rs` (three dispatchers; re-export the three models), `model/remote.rs` (`PullRequestDraft`), `model/mod.rs` (re-export), `remote/mod.rs` (`pub mod pr_draft;`)
- Create: `src-tauri/crates/git-real-core/src/remote/pr_draft.rs`
- Create (test role): `src-tauri/crates/git-real-core/tests/fixtures/hosting/{github_repo,github_search_issues,gitlab_project,gitlab_issues,bitbucket_repo,bitbucket_issues}.json`, `tests/pr_draft.rs`
- Modify (test role): `tests/hosting_providers.rs`, `tests/hosting_http.rs`

**Interfaces:**

- Consumes (verified in code): `http::{get, post_json, send_json, percent_encode, parse_timestamp, unexpected}`; each provider module's private `WirePull` / `WireMergeRequest` / `WirePullRequest` + `convert(p, host)` and `pulls_url` / `merge_requests_url` / `pull_requests_url`; `provider::is_plain_segment`; `refs::validate_branch_name`; `RepoSession::head_branch()` (`pub(crate)`, `UnbornHead` / `DetachedHead`); `RepoSession::repo()`; `refs::is_not_found`; `GitError::RevisionNotFound(String)`.
- Produces:

```rust
// hosting/model.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct HostedRepoInfo { pub default_branch: Option<String>, pub issues_enabled: bool }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct Issue { pub number: u64, pub title: String, pub author: String, pub labels: Vec<String>, pub updated_at: i64, pub web_url: String }
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct NewPullRequest { pub title: String, pub body: String, pub source_branch: String, pub target_branch: String }
// hosting/{github,gitlab,bitbucket}.rs — each:
pub fn repo_info(t: &dyn Transport, repo: &RepoRef, token: &Token) -> Result<HostedRepoInfo, GitError>;
pub fn list_issues(t: &dyn Transport, repo: &RepoRef, token: &Token, query: &str, page: u32) -> Result<Vec<Issue>, GitError>;
pub fn create_pull_request(t: &dyn Transport, repo: &RepoRef, token: &Token, new: &NewPullRequest) -> Result<PullRequest, GitError>;
// hosting/mod.rs — dispatch by repo.provider; create validates both branch names first (InvalidBranchName)
pub fn repo_info(t: &dyn Transport, repo: &RepoRef, token: &Token) -> Result<HostedRepoInfo, GitError>;
pub fn list_issues(t: &dyn Transport, repo: &RepoRef, token: &Token, query: &str, page: u32) -> Result<Vec<Issue>, GitError>;
pub fn create_pull_request(t: &dyn Transport, repo: &RepoRef, token: &Token, new: &NewPullRequest) -> Result<PullRequest, GitError>;
pub use model::{Account, CiState, HostedRepoInfo, Issue, NewPullRequest, PullRequest, RepoContext, UserInfo};
// model/remote.rs (re-exported from model, hence from the crate root)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct PullRequestDraft { pub title: String, pub body: String, pub ahead: u32 }
// remote/pr_draft.rs
pub fn humanize_branch(name: &str) -> String;
impl RepoSession { pub fn pull_request_draft(&self, target: &str) -> Result<PullRequestDraft, GitError>; }
```

- [ ] **Step 1: Write the fixtures** (`tests/fixtures/hosting/`, trimmed to the fields used, each ending with a newline)

| File                        | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github_repo.json`          | `{"full_name":"gorlox/test-repo","default_branch":"main","has_issues":true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `github_search_issues.json` | `{"total_count":3,"items":[{"number":7,"title":"Login fails","user":{"login":"alice"},"labels":[{"name":"bug"},{"name":"P1"}],"updated_at":"2026-10-20T12:00:00Z","html_url":"https://github.com/gorlox/test-repo/issues/7"},{"number":6,"title":"Not an issue","user":{"login":"bob"},"labels":[],"pull_request":{"url":"x"},"updated_at":"2026-10-19T08:30:15Z","html_url":"https://github.com/gorlox/test-repo/pull/6"},{"number":5,"title":"Typo","user":{"login":"bob"},"labels":[],"updated_at":"2026-10-19T08:30:15Z","html_url":"https://github.com/gorlox/test-repo/issues/5"}]}` |
| `gitlab_project.json`       | `{"id":100,"default_branch":"develop","issues_access_level":"disabled","issues_enabled":false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gitlab_issues.json`        | `[{"iid":11,"title":"Crash on start","author":{"username":"alice"},"labels":["bug"],"updated_at":"2026-10-20T12:00:00.123Z","web_url":"https://gitlab.com/group/sub/proj/-/issues/11"}]`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bitbucket_repo.json`       | `{"full_name":"ws/repo","mainbranch":{"name":"master"},"has_issues":false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bitbucket_issues.json`     | `{"pagelen":50,"page":1,"values":[{"id":2,"title":"Slow sync","kind":"bug","reporter":{"nickname":"alice","display_name":"Alice A"},"updated_on":"2026-10-20T12:00:00.123456+00:00","links":{"html":{"href":"https://bitbucket.org/ws/repo/issues/2"}}},{"id":1,"title":"No reporter","reporter":null,"updated_on":"2026-10-19T08:30:15.000000+00:00","links":{"html":{"href":"https://bitbucket.org/ws/repo/issues/1"}}}]}`                                                                                                                                                               |

Epochs: `2026-10-20T12:00:00Z` = `1792497600`, `2026-10-19T08:30:15Z` = `1792398615` (as in 13a).

- [ ] **Step 2: Write the failing error-message tests** (append to `tests/hosting_http.rs`, reusing its `user()` helper)

```rust
#[test]
fn github_validation_errors_surface_the_first_error_message() {
    let body = r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:feat."}]}"#;
    let err = user(&FakeTransport::new().reply(422, body)).unwrap_err();
    assert!(matches!(err, GitError::HostingRejected { ref message } if message == "A pull request already exists for o:feat."));
}

#[test]
fn gitlab_array_messages_are_joined() {
    let body = r#"{"message":["Another open merge request already exists for this source branch: !5","Title can't be blank"]}"#;
    let err = user(&FakeTransport::new().reply(409, body)).unwrap_err();
    assert!(matches!(err, GitError::HostingRejected { ref message }
        if message == "Another open merge request already exists for this source branch: !5; Title can't be blank"));
}

#[test]
fn an_errors_entry_without_a_message_falls_back_to_message() {
    let body = r#"{"message":"Validation Failed","errors":[{"code":"missing_field","field":"title"}]}"#;
    let err = user(&FakeTransport::new().reply(422, body)).unwrap_err();
    assert!(matches!(err, GitError::HostingRejected { ref message } if message == "Validation Failed"));
}

#[test]
fn an_array_message_with_a_non_string_entry_is_skipped() {
    // ["a", 1] → only the strings are joined; [] → falls through to HTTP <status>.
    let err = user(&FakeTransport::new().reply(409, r#"{"message":["a",1]}"#)).unwrap_err();
    assert!(matches!(err, GitError::HostingRejected { ref message } if message == "a"));
    let err = user(&FakeTransport::new().reply(409, r#"{"message":[]}"#)).unwrap_err();
    assert!(matches!(err, GitError::HostingRejected { ref message } if message == "HTTP 409"));
}
```

- [ ] **Step 3: Write the failing provider tests** (append to `tests/hosting_providers.rs`; it already has `tok()`, `repo(provider, host, ns, name)`, `element(list, i)` and loads fixtures with `include_str!`)

Tests, with the assertions each makes:

- `repo_info_for_each_provider`: GitHub fixture → `HostedRepoInfo { default_branch: Some("main"), issues_enabled: true }` and URL `https://api.github.com/repos/gorlox/test-repo`; GitLab fixture (repo `group/sub` / `proj`) → `Some("develop")`, `false`, URL `https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj`; Bitbucket fixture → `Some("master")`, `false`, URL `https://api.bitbucket.org/2.0/repositories/ws/repo`.
- `repo_info_defaults`: `{}` on GitHub → `HostingUnreachable` (no `default_branch`); `{"default_branch":"main"}` → `issues_enabled: true`; GitLab `{"default_branch":null}` → `None`, `true`; GitLab `{"issues_access_level":"private"}` → `true`; GitLab `{"issues_enabled":false}` → `false`; Bitbucket `{"mainbranch":null}` → `None`, `true`; Bitbucket `{}` → `None`, `true`.
- `github_lists_issues_from_search_and_skips_pull_requests`: fixture → two issues, numbers `[7, 5]`; issue 7 has `author == "alice"`, `labels == ["bug", "P1"]`, `updated_at == 1792497600`, `web_url` as in the fixture; the URL equals `https://api.github.com/search/issues?q=repo%3Agorlox%2Ftest-repo%20is%3Aissue%20is%3Aopen&sort=updated&order=desc&per_page=50&page=1`; the request carries the two GitHub headers.
- `gitlab_lists_issues`: fixture → `[Issue { number: 11, author: "alice", labels: ["bug"], updated_at: 1792497600, .. }]`, URL `https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/issues?state=opened&order_by=updated_at&sort=desc&per_page=50&page=2` for page 2.
- `bitbucket_lists_issues_from_values`: fixture → numbers `[2, 1]`; issue 2 `labels == ["bug"]`, `author == "alice"`; issue 1 `author == ""`, `labels == []`; URL `https://api.bitbucket.org/2.0/repositories/ws/repo/issues?pagelen=50&page=1&sort=-updated_on&q=%28state%3D%22new%22%20OR%20state%3D%22open%22%29`.
- `issue_queries_are_percent_encoded_for_every_provider`: query ` login "fails" & #7 \` (with the surrounding spaces) → GitHub `q=` value `repo%3Agorlox%2Ftest-repo%20is%3Aissue%20is%3Aopen%20login%20%22fails%22%20%26%20%237%20%5C`; GitLab ends with `&search=login%20%22fails%22%20%26%20%237%20%5C`; Bitbucket `q=` value is `enc(r#"(state="new" OR state="open") AND title ~ "login fails & #7 "#)` (quotes and backslash removed, computed with `percent_encode` in the test so the expectation is not hand-typed). An all-whitespace query sends the no-query URL on all three.
- `an_issue_list_missing_a_required_field_is_an_unexpected_response`: GitHub `{"items":[{"number":1}]}`, GitLab `[{"iid":1}]`, Bitbucket `{"values":[{"id":1}]}` → `HostingUnreachable { message: "unexpected response from <host>" }`.
- `create_pull_request_for_each_provider`: `NewPullRequest { title: "Add login", body: "Why\n\nDetails", source_branch: "feature/login", target_branch: "main" }`; GitHub replies 201 with `element(github_pulls, 0)` → the result is the converted PR (`number == 12`); the request is `Method::Post` to `https://api.github.com/repos/gorlox/test-repo/pulls`, has `Content-Type: application/json`, `Accept: application/vnd.github+json` (exactly one `Accept` header) and `X-GitHub-Api-Version: 2022-11-28`, and its body parses to exactly `{"title":"Add login","body":"Why\n\nDetails","head":"feature/login","base":"main"}` (compare as `serde_json::Value`). GitLab 201 with `element(gitlab_merge_requests, 0)` → body `{"source_branch":"feature/login","target_branch":"main","title":"Add login","description":"Why\n\nDetails"}`, URL `…/projects/group%2Fsub%2Fproj/merge_requests`. Bitbucket 201 with the first `values` element of `bitbucket_pullrequests.json` → body `{"title":"Add login","description":"Why\n\nDetails","source":{"branch":{"name":"feature/login"}},"destination":{"branch":{"name":"main"}}}`, URL `…/repositories/ws/repo/pullrequests`.
- `create_pull_request_refuses_bad_branch_names_before_any_request`: `source_branch: "-x"` and, separately, `target_branch: "a b"` → `InvalidBranchName`, `t.requests().is_empty()`.
- `create_pull_request_rejection_passes_through`: GitHub 422 with the Review Focus 1 body → `HostingRejected { message: "A pull request already exists for o:feat." }`.
- `issue_and_repo_info_serialize_camel_case`: `serde_json::to_value(HostedRepoInfo { default_branch: None, issues_enabled: true })` == `{"defaultBranch":null,"issuesEnabled":true}`; an `Issue` has keys `number, title, author, labels, updatedAt, webUrl`; `serde_json::from_str::<NewPullRequest>(r#"{"title":"t","body":"","sourceBranch":"s","targetBranch":"m"}"#)` round-trips.

- [ ] **Step 4: Write the failing draft tests** (`tests/pr_draft.rs`; helpers from `tests/common/mod.rs`: `temp_repo_with_commit`, `temp_bare_clone`, `add_remote_and_fetch`, `configure_identity`, `commit_file`, `head_branch_name`, `run_git_ok`)

```rust
//! The pull request draft: commits ahead of `origin/<target>`, the title and body prefill,
//! and branch-name humanizing (GR-13 spec §5.3).

mod common;

use git_real_core::remote::pr_draft::humanize_branch;
use git_real_core::{GitError, PullRequestDraft, RepoSession};

#[test]
fn humanizes_branch_names() {
    for (name, want) in [
        ("feature/add-login", "Add login"), ("fix_typo", "Fix typo"), ("GR-13-hosting", "GR 13 hosting"),
        ("main", "Main"), ("a/b/c--d__e", "C d e"), ("x", "X"),
    ] {
        assert_eq!(humanize_branch(name), want, "{name}");
    }
}

#[test]
fn one_commit_ahead_uses_its_subject_and_body() {
    // repo with origin fetched; branch `feature/login` with one commit "Add login\n\nWhy\n\nDetails\n"
    // → PullRequestDraft { title: "Add login", body: "Why\n\nDetails", ahead: 1 }
}

#[test]
fn several_commits_ahead_humanize_the_branch_name() {
    // two commits on `feature/add-login` → title "Add login", body "", ahead 2
}

#[test]
fn no_commits_ahead_is_ahead_zero_with_the_humanized_name() {
    // branch at origin/<head> → ahead 0, title = humanize_branch(branch), body ""
}

#[test]
fn a_subject_only_commit_has_an_empty_body() {
    // one commit "Just a subject" → body ""
}

#[test]
fn ahead_saturates_at_one_thousand() {
    // 1001 commits created in-process with git2 (`Repository::commit` on HEAD with the same tree,
    // not the CLI, which would take seconds) → ahead == 1000, humanized title
}

#[test]
fn a_missing_target_is_revision_not_found() {
    // target "nope" → Err(GitError::RevisionNotFound(s)) if s == "origin/nope"
}

#[test]
fn an_invalid_target_name_is_invalid_branch_name() {
    // target "-x" → InvalidBranchName("-x"); target "a b" → InvalidBranchName
}

#[test]
fn a_detached_head_is_detached_head() {
    // `git checkout -q --detach` → Err(GitError::DetachedHead)
}

#[test]
fn an_unborn_head_is_unborn_head() {
    // `git init` only, no origin → Err(GitError::UnbornHead) (checked before the target lookup)
}

#[test]
fn draft_serializes_camel_case() {
    // {"title":"t","body":"b","ahead":1}
}
```

The test role writes each body against the fixture helpers (the comments are the assertions to make).

- [ ] **Step 5: Run the new tests to verify they fail**

Run (from `src-tauri`): `cargo test -p git-real-core --test hosting_providers --test hosting_http --test pr_draft`. Expected: compile errors for the missing items (`repo_info`, `list_issues`, `create_pull_request`, `HostedRepoInfo`, `Issue`, `NewPullRequest`, `PullRequestDraft`, `humanize_branch`, `pull_request_draft`) and, once stubbed, failures in the four `message` tests.

- [ ] **Step 6: Implement the core**

- `hosting/http.rs`: change `message` to the five-step order in Global Constraints (`errors[0].message` → `message` string or string-array joined with `; ` → `error` → `error.message` → `HTTP <status>`); keep the redaction and the 200-char cut.
- `hosting/model.rs`: the three structs (Interfaces).
- Each provider module: private wire structs for the repository body and the issue body (`WireRepo` already exists in `github.rs` for PR heads; add the new fields on a separate `WireRepoInfo` so `WirePull` is untouched), `repo_info`, `list_issues` (build the URL exactly as in Global Constraints; GitHub skips items whose `pull_request` is present; Bitbucket strips `"` and `\` from the query), `create_pull_request` (`post_json(url, token, &serde_json::json!({...}))`; on GitHub a private `fn with_github_headers(req: Request) -> Request` in `github.rs` replaces the `Accept` value with `application/vnd.github+json` and pushes `X-GitHub-Api-Version: 2022-11-28`, since `post_json` takes no extra headers; parse with the existing wire struct and `convert`). A tiny private `fn issue_query(q: &str) -> &str` (trim) in `http.rs` or per module, implementer's choice.
- `hosting/mod.rs`: dispatchers; `create_pull_request` runs `validate_branch_name` on `source_branch` and `target_branch` before dispatching; extend the `pub use model::{…}`.
- `model/remote.rs`: `PullRequestDraft`; `model/mod.rs`: add it to the `remote` re-export list.
- `remote/pr_draft.rs`: `humanize_branch` and `RepoSession::pull_request_draft` per Global Constraints (git2 `Revwalk`: `push_head`, `hide(target_oid)`, count with `take(1001)` and saturate; the single commit's `summary()` and `body()`); `remote/mod.rs`: `pub mod pr_draft;`.

- [ ] **Step 7: Run the tests and static checks**

Run (from `src-tauri`): `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`. Expected: all pass; the 13a `hosting_http.rs` message tests still pass unchanged.

- [ ] **Step 8: Commit** (explicit paths only; never `git add -A`, `reset`, `amend` or `stash`)

```bash
git add src-tauri/crates/git-real-core/src/hosting src-tauri/crates/git-real-core/src/model/remote.rs src-tauri/crates/git-real-core/src/model/mod.rs src-tauri/crates/git-real-core/src/remote/mod.rs src-tauri/crates/git-real-core/src/remote/pr_draft.rs
git commit -m "feat(core): GR-13b repository info, issue search, create pull request, PR draft"
```

(The test role commits its fixtures and tests first, as `test: GR-13b core (red)`.)

---

### Task 2: App layer — four commands and the IPC seam

**Files:**

- Modify: `src-tauri/src/commands/hosting.rs` (`CreatePrRequest`, four `*_inner` functions, four commands), `src-tauri/src/lib.rs` (register the four commands after `hosting_checkout_pull_request`)
- Modify: `src/lib/ipc/types.ts` (`HostedRepoInfo`, `Issue`, `NewPullRequest`, `PullRequestDraft`, `CreatePrRequest`), `src/lib/ipc/commands.ts` (four wrappers), `src/lib/ipc/index.ts` (exports, if it re-exports by name), `src/lib/query/keys.ts` (`hostingRepoInfo`, `issues`, `prDraft`)
- Modify (test role): `src-tauri/tests/hosting_commands.rs`, `src/lib/ipc/commands.test.ts`, `src/lib/ipc/types.test.ts` (if it enumerates shapes), `src/lib/query/keys.test.ts`

**Interfaces:**

- Consumes: Task 1's `hosting::{repo_info, list_issues, create_pull_request, HostedRepoInfo, Issue, NewPullRequest}`, `git_real_core::{PullRequestDraft, PushTarget}`, `RepoSession::pull_request_draft`; 13a's `connected_repo`, `with_token`, `with_session`, `run_blocking`, `NetworkAuth::new`, `credentials_from_arg`, `push_inner(reg, id, &PushTarget, force, expected_branch, auth)`; test helpers `hosted()`, `Hosted::connect`, `FakeTransport`, `github_pr(n, src, fork)`, `push_branch_to_bare`, `git(dir, args)`, `ref_oid`.
- Produces:

```rust
// commands/hosting.rs
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CreatePrRequest { pub branch: String, pub push: Option<PushTarget>, pub pr: NewPullRequest }
pub fn hosting_repo_info_inner(reg: &RepoRegistry, store: &HostingStore, t: &dyn Transport, id: RepoId) -> Result<HostedRepoInfo, AppError>;
pub fn hosting_list_issues_inner(reg: &RepoRegistry, store: &HostingStore, t: &dyn Transport, id: RepoId, query: &str, page: u32) -> Result<Vec<Issue>, AppError>;
pub fn hosting_pull_request_draft_inner(reg: &RepoRegistry, id: RepoId, target: &str) -> Result<PullRequestDraft, AppError>;
pub fn hosting_create_pull_request_inner(reg: &RepoRegistry, store: &HostingStore, t: &dyn Transport, id: RepoId, request: &CreatePrRequest, credentials: Option<&Credentials>) -> Result<PullRequest, AppError>;
// commands: hosting_repo_info { id }, hosting_list_issues { id, query, page }, hosting_pull_request_draft { id, target },
//           hosting_create_pull_request { id, request, credentials }
```

```ts
// types.ts
export interface HostedRepoInfo { defaultBranch: string | null; issuesEnabled: boolean }
export interface Issue { number: number; title: string; author: string; labels: string[]; updatedAt: number; webUrl: string }
export interface NewPullRequest { title: string; body: string; sourceBranch: string; targetBranch: string }
export interface PullRequestDraft { title: string; body: string; ahead: number }
export interface CreatePrRequest { branch: string; push: PushTarget | null; pr: NewPullRequest }
// commands.ts
export function hostingRepoInfo(id: RepoId): Promise<HostedRepoInfo>;
export function hostingListIssues(id: RepoId, query: string, page: number): Promise<Issue[]>;
export function hostingPullRequestDraft(id: RepoId, target: string): Promise<PullRequestDraft>;
export function hostingCreatePullRequest(id: RepoId, request: CreatePrRequest, credentials: Credentials | null = null): Promise<PullRequest>;
// keys.ts
hostingRepoInfo: (id: RepoId) => ["hosting", "repoInfo", id] as const,
issues: (id: RepoId, query: string) => ["hosting", "issues", id, query] as const,
prDraft: (id: RepoId, target: string) => ["repo", id, "prDraft", target] as const,
```

- [ ] **Step 1: Write the failing command tests** (append to `src-tauri/tests/hosting_commands.rs`)

Each test uses `hosted()` (origin `https://github.com/o/r.git` redirected to a local bare clone) and `h.connect()` unless stated. The assertions:

- `repo_info_passes_through_the_provider_answer`: `FakeTransport::new().reply(200, r#"{"default_branch":"main","has_issues":false}"#)` → `HostedRepoInfo { default_branch: Some("main"), issues_enabled: false }`; the request URL is `https://api.github.com/repos/o/r`.
- `repo_info_without_an_account_is_no_hosting_account`: no connect, empty transport → `AppErrorKind::NoHostingAccount`, no request.
- `list_issues_passes_the_query_and_page`: reply `{"items":[]}` → `Ok(vec![])`; URL contains `q=repo%3Ao%2Fr%20is%3Aissue%20is%3Aopen%20crash` and `&page=3` for `("crash", 3)`; `page: 0` is sent as `page=1`.
- `list_issues_with_a_rejected_token_marks_the_account_for_reconnect`: reply 401 → `HostingAuth` and `h.store.accounts()[0].needs_reconnect`.
- `pull_request_draft_reads_commits_ahead_of_origin`: on a new branch `feat` with one commit `"Add thing\n\nBody\n"` → `PullRequestDraft { title: "Add thing", body: "Body", ahead: 1 }` for `target = &h.head`; no transport, no account needed.
- `pull_request_draft_with_an_unknown_target_is_revision_not_found`: `target = "nope"` → `AppErrorKind::RevisionNotFound` (whatever the 13a mapping names it; the test role reads `error.rs`).
- `pull_request_draft_for_an_unknown_repo_is_repo_not_found`: `MISSING_ID` → the registry's not-found kind (as other `*_inner` tests assert it).
- `create_without_a_push_posts_and_returns_the_pull_request`: branch `feat` pushed to the bare beforehand with `push_branch_to_bare(&h.bare, "feat")` then `git fetch`; request `CreatePrRequest { branch: "feat", push: None, pr: NewPullRequest { title: "T", body: "B", source_branch: "feat", target_branch: h.head } }`; reply 201 `github_pr(21, "feat", false)` → `Ok(pr)` with `pr.number == 21`; exactly one request, `Method::Post`, body JSON `{"title":"T","body":"B","head":"feat","base":<head>}`.
- `create_with_publish_pushes_the_branch_first`: local branch `feat` with one commit, not on the bare; `push: Some(PushTarget::SetUpstream { remote: "origin", branch: "feat" })` → after `Ok`, `ref_oid(&h.bare, "refs/heads/feat")` is the local tip, the local branch's upstream is `origin/feat` (`git rev-parse --abbrev-ref feat@{upstream}` → `origin/feat`), and the provider request came after (one request).
- `create_with_push_ahead_pushes_to_the_upstream`: `feat` published, then one more local commit; `push: Some(PushTarget::Upstream)` → the bare's `refs/heads/feat` equals the new tip.
- `create_with_a_failing_push_sends_no_provider_request`: `push: Some(PushTarget::SetUpstream { remote: "nope", branch: "feat" })` → `AppErrorKind::RemoteNotFound`, `t.requests().is_empty()`.
- `create_when_head_moved_is_operation_in_progress`: `branch: "other"` while HEAD is `feat` with `push: Some(PushTarget::Upstream)` → `AppErrorKind::OperationInProgress` (from `prepare_push`), no request.
- `create_rejection_passes_through`: reply 422 with the Review Focus 1 body → `AppErrorKind::HostingRejected` and `err.message` contains `already exists`.
- `create_without_an_account_is_no_hosting_account`: no connect → `NoHostingAccount`, no request, and (with `push: Some(SetUpstream…)`) the bare has no `refs/heads/feat` (the account check happens before the push).

- [ ] **Step 2: Write the failing IPC and key tests**

- `src/lib/ipc/commands.test.ts`: `hostingRepoInfo(3)` invokes `hosting_repo_info` with `{ id: 3 }`; `hostingListIssues(3, "crash", 2)` → `hosting_list_issues` `{ id: 3, query: "crash", page: 2 }`; `hostingPullRequestDraft(3, "main")` → `hosting_pull_request_draft` `{ id: 3, target: "main" }`; `hostingCreatePullRequest(3, request)` → `hosting_create_pull_request` `{ id: 3, request, credentials: null }` and with credentials passes them through.
- `src/lib/query/keys.test.ts`: `hostingRepoInfo(1)` and `issues(1, "q")` do **not** start with `["repo", 1]` and do start with `"hosting"`; `issues(1, "a") !== issues(1, "b")` by value; `prDraft(1, "main")` equals `["repo", 1, "prDraft", "main"]`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --test hosting_commands` (from `src-tauri`) and `npx vitest run src/lib/ipc src/lib/query`. Expected: compile errors / failing imports for the missing functions and keys.

- [ ] **Step 4: Implement**

- `commands/hosting.rs`: `CreatePrRequest`; `hosting_repo_info_inner` and `hosting_list_issues_inner` follow `hosting_list_pull_requests_inner` (`connected_repo` → `with_token` → core; `page.max(1)`); `hosting_pull_request_draft_inner` = `with_session(reg, id, |s| s.pull_request_draft(target))`; `hosting_create_pull_request_inner`: `connected_repo` first, then `if let Some(target) = &request.push { push_inner(reg, id, target, false, &request.branch, NetworkAuth::new(credentials, store))?; }`, then `with_token(… hosting::create_pull_request(t, &repo, token, &request.pr))`. Four `#[tauri::command]` wrappers in the 13a shape (`credentials_from_arg` for the create).
- `lib.rs`: register the four commands.
- `types.ts`, `commands.ts`, `keys.ts` as in Interfaces; `index.ts` exports if it lists names.

- [ ] **Step 5: Run all checks**

Run (from `src-tauri`): `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`; from the root: `npm run typecheck && npx vitest run src/lib`. Expected: green.

- [ ] **Step 6: Commit** (explicit paths)

```bash
git add src-tauri/src/commands/hosting.rs src-tauri/src/lib.rs src/lib/ipc/types.ts src/lib/ipc/commands.ts src/lib/ipc/index.ts src/lib/query/keys.ts
git commit -m "feat: GR-13b hosting commands (repo info, issues, PR draft, create PR) and IPC wrappers"
```

---

### Task 3: Front end — create pull request dialog, entry points, toast

**Files:**

- Create: `src/features/hosting/useRepoInfo.ts`, `usePullRequestDraft.ts`, `createPrPlan.ts`, `useCreatePullRequest.ts`, `CreatePullRequestDialog.tsx` + `.module.css`; `src/lib/store/toasts.ts`; `src/components/Toasts.tsx` + `.module.css`
- Modify: `src/features/hosting/hostingCopy.ts` (`pushFirstLabel`, `PUBLISH_FIRST_TEXT`, `openedToastText`), `src/features/hosting/PullRequestsPanel.tsx` (`onCreatePullRequest` prop; header `+` button between the heading and Refresh), `src/features/remotes/SyncToolbar.tsx` (`onCreatePullRequest` prop; Push ▾ first item), `src/features/branches/BranchesPanel.tsx` (`onCreatePullRequest` prop; HEAD local branch menu item after `Checkout`), `src/app/RepoPane.tsx` (owns `createPr` state, computes the callback, mounts `CreatePullRequestDialog`, passes the prop to the three), `src/app/App.tsx` (mounts `<Toasts />` once, after the panes)
- Test (test role): a `*.test.ts(x)` beside each new file; extend `hostingCopy.test.ts`, `PullRequestsPanel.test.tsx`, `SyncToolbar.test.tsx`, `BranchesPanel.test.tsx`, `RepoPane.test.tsx`, `App.test.tsx`, `src/test/hostingFixtures.ts` (`repoInfo()`, `prDraft()`, `issue()` fixtures), `src/styles/focusTargets.test.ts` if its allow-list must name `CreatePullRequestDialog.tsx` (the test role reads the rule)

**Interfaces:**

- Consumes: Task 2's wrappers, types and keys; `useBranches(repoId)` → `{ branches: BranchList | undefined }`; `useRemotes(repoId)` → `{ remotes }`; `upstreamRemote(upstream, remotes)` from `features/remotes/syncCopy.ts`; `useNetworkAction`, `CredentialDialog`, `NetworkError`, `hostingMessage`, `hostingErrorText`, `useRestoreFocus`, `openExternal`, `toAppError`, `ConfirmDialog`-style CSS (`ConnectAccountDialog.module.css` is the pattern to mirror; no cross-feature CSS imports).
- Produces:

```ts
// useRepoInfo.ts — ["hosting","repoInfo",id]; refetchOnWindowFocus: false; staleTime 5 min
export function useRepoInfo(repoId: RepoId, enabled: boolean): { info: HostedRepoInfo | undefined; error: AppError | null; refetch(): void };
// usePullRequestDraft.ts — ["repo",id,"prDraft",target]; disabled while target === null; staleTime Infinity
export function usePullRequestDraft(repoId: RepoId, target: string | null): { draft: PullRequestDraft | undefined; settled: boolean };
// createPrPlan.ts (pure)
export type PrPushPlan = { kind: "publish" } | { kind: "push"; ahead: number } | { kind: "none" };
/** publish when no upstream, upstream not on origin, or upstream gone (ahead === null); push when ahead > 0; else none. */
export function prPushPlan(tracking: Tracking | null, remotes: string[]): PrPushPlan;
/** The head branch's name on origin: the local name when publishing, else tracking.upstream without "origin/". */
export function originBranchName(local: string, tracking: Tracking | null, plan: PrPushPlan): string;
/** info.defaultBranch when present among `originBranches` (names), else "main" when present, else the first, else null. */
export function defaultTarget(info: HostedRepoInfo | undefined, originBranches: string[]): string | null;
export function pushTargetFor(plan: PrPushPlan, pushFirst: boolean, local: string): PushTarget | null;
// useCreatePullRequest.ts
export interface CreatePrInput { title: string; body: string; target: string; pushFirst: boolean }
export function useCreatePullRequest(repoId: RepoId, local: string, tracking: Tracking | null, remotes: string[]): {
  plan: PrPushPlan;
  /** Resolves with the PR (toast shown) or null (error set, or cancelled). */
  submit(input: CreatePrInput): Promise<PullRequest | null>;
  pending: boolean; error: AppError | null; clearError(): void; prompt: CredentialPrompt | null;
};
// CreatePullRequestDialog.tsx
export interface CreatePullRequestDialogProps { repoId: RepoId; onClose(): void; fallbackFocus?: RefObject<HTMLElement | null> }
export function CreatePullRequestDialog(props: CreatePullRequestDialogProps): JSX.Element;
// hostingCopy.ts additions
export const PUBLISH_FIRST_TEXT = "This branch isn't on the remote yet — it will be published first";
export function pushFirstLabel(ahead: number): string;      // "Push 1 commit first" | "Push 3 commits first"
export function openedToastText(number: number): string;    // "Opened #124"
// lib/store/toasts.ts
export interface Toast { id: number; text: string; action: { label: string; run(): void } | null }
export const useToasts: UseBoundStore<StoreApi<{ toasts: Toast[]; show(text: string, action?: Toast["action"]): number; dismiss(id: number): void }>>;
// components/Toasts.tsx — role="status" aria-live="polite" region; each toast auto-dismisses after TOAST_MS = 8000
export function Toasts(): JSX.Element;
// props added
SyncToolbarProps.onCreatePullRequest: (() => void) | null;
BranchesPanelProps.onCreatePullRequest: (() => void) | null;
PullRequestsPanelProps.onCreatePullRequest: (() => void) | null;
```

- [ ] **Step 1: Extend the fixtures** (`src/test/hostingFixtures.ts`): `repoInfo(over?)` → `{ defaultBranch: "main", issuesEnabled: true }`; `prDraft(over?)` → `{ title: "Add login", body: "Why", ahead: 1 }`; `issue(number, over?)` → `{ number, title: \`Issue ${number}\`, author: "alice", labels: ["bug"], updatedAt: 1792497600, webUrl: \`https://github.com/gorlox/test-repo/issues/${number}\` }`.

- [ ] **Step 2: Write the failing pure and hook tests**

- `createPrPlan.test.ts`: `prPushPlan(null, ["origin"])` → publish; `prPushPlan({ upstream: "fork/feat", ahead: 0, behind: 0 }, ["origin", "fork"])` → publish; `ahead: null` → publish; `{ upstream: "origin/feat", ahead: 2, behind: 0 }` → `{ kind: "push", ahead: 2 }`; `ahead: 0` → none. `originBranchName("feat", tracking("origin/renamed"), none)` → `"renamed"`; publishing → `"feat"`. `defaultTarget(repoInfo({ defaultBranch: "develop" }), ["main", "develop"])` → `"develop"`; default not present → `"main"`; neither → first; `[]` → null; `undefined` info with `["x"]` → `"x"`. `pushTargetFor(publish, false, "feat")` → `{ kind: "setUpstream", remote: "origin", branch: "feat" }`; `(push 2, true)` → `{ kind: "upstream" }`; `(push 2, false)` → null; `(none, true)` → null.
- `hostingCopy.test.ts`: `pushFirstLabel(1)` → `Push 1 commit first`, `(3)` → `Push 3 commits first`; `openedToastText(124)` → `Opened #124`.
- `useRepoInfo.test.tsx`: disabled → no call; enabled → `hostingRepoInfo(id)` once; cached under `queryKeys.hostingRepoInfo(id)`; error exposed as `AppError`.
- `usePullRequestDraft.test.tsx`: `target === null` → no call and `settled === false`; with a target → `hostingPullRequestDraft(id, target)` once, `draft` set, `settled` true; a rejected draft → `draft` undefined and `settled` true.
- `useCreatePullRequest.test.tsx` (mock `hostingCreatePullRequest`, `openExternal`): submit with plan publish → `hostingCreatePullRequest(id, { branch: "feat", push: { kind: "setUpstream", remote: "origin", branch: "feat" }, pr: { title, body, sourceBranch: "feat", targetBranch: "main" } }, null)`; with plan push and `pushFirst: true` → `push: { kind: "upstream" }` and `sourceBranch` from the upstream; `pushFirst: false` → `push: null`; success resolves with the PR and `useToasts.getState().toasts[0]` has text `Opened #124` and an action whose `run` calls `openExternal(pr.webUrl)`; a rejected call resolves null with `error.kind === "hostingRejected"` and no toast; an HTTPS auth failure opens `prompt` and a cancel resolves null with `error === null`; `pending` is true while in flight.
- `toasts.test.ts`: `show` returns increasing ids and appends; `dismiss` removes; `show` without an action stores `action: null`.
- `Toasts.test.tsx` (fake timers): renders text and the action button; the action runs `run` and dismisses; `Dismiss notification` removes it; a toast disappears after 8000 ms and not at 7999 ms; two toasts stack in order.

- [ ] **Step 3: Write the failing component tests**

- `CreatePullRequestDialog.test.tsx` (mock `listBranches`, `listRemotes`, `hostingRepoContext`, `hostingRepoInfo`, `hostingPullRequestDraft`, `hostingCreatePullRequest`, `openExternal`): shows `Loading…` then the form; Source shows the HEAD branch; Target options are origin's branches minus the source, default `develop` when `repoInfo({ defaultBranch: "develop" })`; Title/Description prefilled from the draft; `PUBLISH_FIRST_TEXT` shown when no upstream and no checkbox; `Push 2 commits first` checkbox checked by default when ahead 2; neither when ahead 0; Create disabled while the title is blank; submit calls `hostingCreatePullRequest` with the typed title/body and the chosen target; success calls `onClose`; `keeps the dialog open with the push error` (rejected `networkFailed` → `NetworkError` inside the dialog, `onClose` not called); `stays open without an error when the sign-in is cancelled` (auth failure → `CredentialDialog` → Cancel → no error, still open); `hostingRejected` shows the provider's message inline; repo info error shows the hosting copy and still renders the form with target `main`; no origin branches → `origin has no branches to target. Fetch first.` and `Close`; detached HEAD → `Check out a branch to open a pull request.`; Escape cancels when not pending and is ignored while pending; focus lands on the Title field when the form mounts; a draft error leaves Title and Description empty.
- `PullRequestsPanel.test.tsx`: the `Create pull request` button calls the prop; it is disabled when the prop is null.
- `SyncToolbar.test.tsx`: Push ▾ lists `Create pull request…` first when the prop is set and omits it when null; selecting it calls the prop.
- `BranchesPanel.test.tsx`: the HEAD branch's menu has `Create pull request…` after `Checkout` when the prop is set; other local branches and remote branches never show it; null hides it.
- `RepoPane.test.tsx`: with `hostingRepoContext` → `repoContext()` and HEAD on a branch, the Push ▾ item exists and opens the dialog (`Create pull request` heading); with `account: null`, with `needsReconnect: true`, or with a detached HEAD, the item is absent; closing the dialog returns focus to the toolbar.
- `App.test.tsx`: `useToasts.getState().show("Hi")` renders `Hi` in a status region.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/features/hosting src/features/remotes/SyncToolbar.test.tsx src/features/branches/BranchesPanel.test.tsx src/app src/components/Toasts.test.tsx src/lib/store/toasts.test.ts`. Expected: failing imports and missing props.

- [ ] **Step 5: Implement**

- Hooks and pure helpers per Interfaces. `useCreatePullRequest.submit`: `plan = prPushPlan(tracking, remotes)`; `request = { branch: local, push: pushTargetFor(plan, input.pushFirst, local), pr: { title: input.title.trim(), body: input.body, sourceBranch: originBranchName(local, tracking, plan), targetBranch: input.target } }`; `network.run((c) => hostingCreatePullRequest(repoId, request, c))`; on ok `useToasts.getState().show(openedToastText(pr.number), { label: "Open in browser", run: () => void openExternal(pr.webUrl) })`.
- `CreatePullRequestDialog`: a backdrop + `role="dialog"` box (mirror `ConnectAccountDialog`: `useRestoreFocus(fallbackFocus)`, no backdrop-click close, Escape when not pending, focus held on the box while pending); reads `useBranches`, `useRemotes`, `useRepoContext`, `useRepoInfo(repoId, true)`; the inner `CreatePrForm` mounts only when branches and repo info have settled and the draft for `defaultTarget(...)` has settled, with `useState` initial values from the draft (the PromptDialogBody pattern); the `CredentialDialog` renders last.
- `Toasts`: one `setTimeout` per toast (cleared on unmount/dismiss); mounted in `App.tsx`.
- Entry points and `RepoPane` as in Deviations.

- [ ] **Step 6: Run the full front-end gate**

Run: `npm run test:coverage && npm run lint && npm run typecheck && npx prettier --check .`. Expected: all tests pass, coverage 100/100/100/100 for `src/`, lint 0 errors (the DiffViewer warning is pre-existing).

- [ ] **Step 7: Commit** (explicit paths)

```bash
git add src/features/hosting/useRepoInfo.ts src/features/hosting/usePullRequestDraft.ts src/features/hosting/createPrPlan.ts src/features/hosting/useCreatePullRequest.ts src/features/hosting/CreatePullRequestDialog.tsx src/features/hosting/CreatePullRequestDialog.module.css src/features/hosting/hostingCopy.ts src/features/hosting/PullRequestsPanel.tsx src/features/remotes/SyncToolbar.tsx src/features/branches/BranchesPanel.tsx src/app/RepoPane.tsx src/app/App.tsx src/lib/store/toasts.ts src/components/Toasts.tsx src/components/Toasts.module.css
git commit -m "feat(ui): GR-13b create pull request dialog, entry points, toasts"
```

---

### Task 4: Front end — Issues panel, issue picker, commit editor link

**Files:**

- Create: `src/features/hosting/useIssues.ts`, `useLinkActions.ts`, `IssueRow.tsx` + `.module.css`, `IssuesPanel.tsx` + `.module.css`, `IssuePicker.tsx` + `.module.css`; `src/features/commit/issueRef.ts`
- Modify: `src/features/hosting/hostingCopy.ts` (`issueCountLabel`, `ISSUES_OFF_TEXT`), `src/lib/store/layoutPrefs.ts` (`issuesCollapsed: true`, `setIssuesCollapsed`, persisted), `src/features/commit/MessageEditor.tsx` (`onLinkIssue` prop, `#` button, shortcut, caret restore), `src/features/commit/CommitBox.tsx` (`useRepoContext`, owns the `IssuePicker`), `src/app/RepoPane.tsx` (`<IssuesPanel repoId={tab.id} />` after `PullRequestsPanel`)
- Test (test role): a `*.test.ts(x)` beside each new file; extend `hostingCopy.test.ts`, `layoutPrefs.test.ts`, `MessageEditor.test.tsx`, `CommitBox.test.tsx`, `RepoPane.test.tsx`, `src/styles/focusTargets.test.ts` if required for `IssuePicker.tsx`

**Interfaces:**

- Consumes: Task 2's `hostingListIssues`, `Issue`, `queryKeys.issues`; Task 3's `useRepoInfo`; 13a's `useRepoContext`, `PullRequestsPanel` structure (mirror it; `IssuesPanel.module.css` repeats the section rules, no cross-feature CSS import), `ContextMenu`, `NetworkError`, `hostingMessage`, `AccountsDialog` + `AccountsPreset`, `RECONNECT_TEXT`, `PROVIDER_LABEL`, `copyText`, `openExternal`, `useRestoreFocus`, `useCommitDraft`.
- Produces:

```ts
// useIssues.ts — infinite query on ["hosting","issues",id,query]; PAGE_SIZE 50; refetchOnWindowFocus false
export function useIssues(repoId: RepoId, query: string, enabled: boolean): {
  issues: Issue[] | undefined; error: AppError | null; hasMore: boolean; fetching: boolean; loadingMore: boolean; refetch(): void; loadMore(): void;
};
// useLinkActions.ts — open/copy of any provider URL; failures land in error
export function useLinkActions(): { open(url: string): void; copyLink(url: string): void; error: AppError | null; clearError(): void };
// IssueRow.tsx
export interface IssueRowProps { issue: Issue; onOpen(): void; onContextMenu(x: number, y: number): void }
// IssuesPanel.tsx — null without a hosted origin
export function IssuesPanel({ repoId }: { repoId: RepoId }): JSX.Element | null;
// IssuePicker.tsx — a popover dialog; the first page only; DEBOUNCE_MS = 300
export interface IssuePickerProps { repoId: RepoId; provider: HostingProvider; onPick(number: number): void; onClose(): void }
export function IssuePicker(props: IssuePickerProps): JSX.Element;
// hostingCopy.ts additions
export const ISSUES_OFF_TEXT = "Issues are turned off for this repository";
export function issueCountLabel(count: number | null, more: boolean): string;  // "Issues" | "Issues (3)" | "Issues (50+)"
// commit/issueRef.ts (pure)
export function insertIssueRef(value: string, start: number, end: number, ref: string): { value: string; caret: number };
// MessageEditor.tsx
export interface MessageEditorProps { …existing; /** Shows the # button and binds Ctrl/Cmd+Shift+I; called with an inserter bound to the triggering field and caret. */ onLinkIssue?(insert: (text: string) => void): void }
// layoutPrefs.ts
issuesCollapsed: boolean; setIssuesCollapsed(collapsed: boolean): void;   // default true, persisted
```

- [ ] **Step 1: Write the failing pure, store and hook tests**

- `issueRef.test.ts` (`insertIssueRef(value, start, end, ref)`; `caret` is the index right after the inserted text, spaces included):

  | input                         | value           | caret | why                                                 |
  | ----------------------------- | --------------- | ----- | --------------------------------------------------- |
  | `("Fix login", 3, 3, "#12")`  | `Fix #12 login` | 7     | `x` before → leading space; ` ` after → no trailing |
  | `("Fixlogin", 3, 3, "#12")`   | `Fix #12 login` | 8     | mid-word: both spaces added                         |
  | `("Fix login", 9, 9, "#12")`  | `Fix login #12` | 13    | at the end: leading space only                      |
  | `("", 0, 0, "#12")`           | `#12`           | 3     | empty field: no spaces                              |
  | `("Fix  login", 4, 4, "#12")` | `Fix #12 login` | 7     | spaces on both sides already: none added            |
  | `("Fix login", 4, 9, "#12")`  | `Fix #12`       | 7     | the selection `login` is replaced                   |
  | `("a\nb", 1, 1, "#1")`        | `a #1\nb`       | 4     | a newline counts as whitespace                      |

- `hostingCopy.test.ts`: `issueCountLabel(null, false)` → `Issues`; `(3, false)` → `Issues (3)`; `(50, true)` → `Issues (50+)`.
- `layoutPrefs.test.ts`: `issuesCollapsed` defaults to true, `setIssuesCollapsed(false)` persists under `git-real.layoutPrefs`.
- `useIssues.test.tsx`: mirrors `usePullRequests.test.tsx` (disabled → no call; enabled → `hostingListIssues(id, query, 1)`; a 50-item page sets `hasMore`; `loadMore` requests page 2; cached under `queryKeys.issues(id, query)`; `does not refetch when the repo prefix is invalidated`; a different query is a different cache entry).
- `useLinkActions.test.tsx`: `open` calls `openExternal(url)`; `copyLink` calls `copyText(url)`; a rejected call sets `error`; `clearError` clears it.

- [ ] **Step 2: Write the failing component tests**

- `IssueRow.test.tsx`: renders `#7`, the title, the author, one badge per label; the open icon is named `Open #7 in browser` and calls `onOpen`; right-click calls `onContextMenu(x, y)`; `title` attribute is the full updated-at date (as `PullRequestRow`).
- `IssuesPanel.test.tsx` (mirror the PR panel suite): hidden without a context; starts collapsed by default (`useLayoutPrefs` default) and `does not request issues while collapsed`; expanding requests `hostingRepoInfo` then `hostingListIssues(id, "", 1)`; `does not request issues when they are turned off` and shows `ISSUES_OFF_TEXT`; `Connect your GitHub account to see issues` + `Connect…` opens the accounts dialog preset; reconnect state; `Loading issues…`; `No open issues`; heading counts; `Show more`; `Refresh issues` disabled while collapsed/unusable/fetching; the context menu `Open in browser` / `Copy link` call the wrappers; a failed first page shows the hosting copy; a failed Show more keeps the list.
- `IssuePicker.test.tsx` (fake timers for the debounce): the search field has focus on open; `requests once after the debounce` (typing `cra`, `cras`, `crash` within 300 ms → one call with `"crash"`); the list shows `#7 Issue 7` options; click calls `onPick(7)`; ArrowDown + Enter picks the second; Escape calls `onClose`; `Searching…` while fetching; `No open issues match`; `ISSUES_OFF_TEXT` when `repoInfo({ issuesEnabled: false })` (and no issues request); a hosting error shows its copy; the dialog is named `Link issue`.
- `MessageEditor.test.tsx`: without `onLinkIssue` there is no `Link issue` button and Ctrl+Shift+I does nothing; with it, the button calls `onLinkIssue` and the inserter writes into the **body** by default (`onBodyChange("… #12")`); after focusing the subject and pressing Ctrl+Shift+I, the inserter writes into the subject at its caret via `onSubjectChange`; the key event is `preventDefault`ed (Review Focus 4); Meta+Shift+I works too; after inserting, the field has focus and `selectionStart === caret`.
- `CommitBox.test.tsx`: with `hostingRepoContext` → `repoContext()` the `Link issue` button exists; with `null` or `account: null` it does not; clicking it opens the `Link issue` dialog; picking `#7` updates the draft body in `useCommitDraft` and closes the picker.
- `RepoPane.test.tsx`: the Issues section renders after Pull requests when the context is hosted.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/features/hosting src/features/commit src/lib/store/layoutPrefs.test.ts src/app/RepoPane.test.tsx`. Expected: failing imports and missing props.

- [ ] **Step 4: Implement**

- `useIssues` as `usePullRequests` with the query in the key; `useLinkActions`; `IssueRow`/`IssuesPanel` mirroring `PullRequestRow`/`PullRequestsPanel` (the panel reads `useRepoInfo(repoId, expanded && usable)` and enables `useIssues` only when `info?.issuesEnabled !== false`); `IssuePicker`: a `role="dialog"` popover positioned under the editor (CSS; absolute within `CommitBox`'s `position: relative` root), `useRestoreFocus()`, a `useState` query debounced into `useIssues` with `setTimeout(DEBOUNCE_MS)`, `role="listbox"`/`role="option"` with `aria-activedescendant`, Arrow/Enter/Escape handling.
- `issueRef.ts` per Global Constraints.
- `MessageEditor`: a `lastField` ref (`"subject" | "body"`, updated on focus of either field, body by default), the `#` button (`aria-label="Link issue"`, in the body label row), `onKeyDown` on both fields catching `(ctrlKey || metaKey) && shiftKey && key.toLowerCase() === "i"` → `preventDefault()` then trigger; the inserter captures the element and its `selectionStart/End`, calls `insertIssueRef`, dispatches `onSubjectChange`/`onBodyChange`, and sets a `caret` state applied in a `useLayoutEffect` (focus + `setSelectionRange`) then cleared.
- `CommitBox`: `useRepoContext(repoId)`; `onLinkIssue` only when `context?.account` exists; `picker` state holds the inserter; renders `<IssuePicker repoId provider onPick={(n) => { picker.insert(\`#${n}\`); setPicker(null); }} onClose={() => setPicker(null)} />`.
- `layoutPrefs`, `hostingCopy`, `RepoPane` as listed.

- [ ] **Step 5: Run the full front-end gate**

Run: `npm run test:coverage && npm run lint && npm run typecheck && npx prettier --check .`. Expected: green at 100 % coverage.

- [ ] **Step 6: Commit** (explicit paths)

```bash
git add src/features/hosting/useIssues.ts src/features/hosting/useLinkActions.ts src/features/hosting/IssueRow.tsx src/features/hosting/IssueRow.module.css src/features/hosting/IssuesPanel.tsx src/features/hosting/IssuesPanel.module.css src/features/hosting/IssuePicker.tsx src/features/hosting/IssuePicker.module.css src/features/hosting/hostingCopy.ts src/features/commit/issueRef.ts src/features/commit/MessageEditor.tsx src/features/commit/CommitBox.tsx src/lib/store/layoutPrefs.ts src/app/RepoPane.tsx
git commit -m "feat(ui): GR-13b issues panel, issue picker, commit editor issue link"
```

---

## Acceptance walk (after the gate, against `gorlox/test-repo` with the connected GitHub account)

1. On a new local branch with one commit: Push ▾ → **Create pull request…** shows the publish notice, the commit's subject and body prefilled, target `main`; Create → the branch appears on GitHub, the PR opens, the toast says `Opened #<n>` and **Open in browser** opens it; the Pull requests list shows it on top.
2. Add a second commit, open the dialog from the branch's context menu: `Push 1 commit first` is checked; uncheck it, submit → GitHub answers 422 (a PR already exists), shown inline; close.
3. Open the dialog from the PR panel's `+` on a branch that is behind `main` after a remote change: the push fails with the non-fast-forward message inline (expected per the calls).
4. Expand **Issues**: open issues listed with labels; **Open in browser** and **Copy link** work; collapse → no request on refresh of the repo.
5. In the commit editor, type `Fix login`, press Ctrl+Shift+I, type part of an issue title, Enter → `Fix login #<n>` with the caret after it; the `#` button does the same into the body.
6. Disconnect the account: the `#` button disappears, both sections show the Connect notice; reconnect.
7. Clean up: close the walk PR and delete its branch on GitHub.

GitLab and Bitbucket rest on the fixture tests unless the user has accounts there (spec §8).
