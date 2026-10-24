# GR-13c Clone Repository Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The clone dialog gets a **From account** tab beside the URL entry: pick a connected account (when there is more than one), search the account's repositories server-side, page through name / owner / private badge / description / last update, and pick one to fill the clone URL in the user's preferred form (HTTPS or SSH, remembered). The rest of the clone flow is unchanged, and a private HTTPS clone works because the clone command already supplies the account token (13a, spec §6.3). This is slice 13c of GR-13 (AC 7), the last slice.

**Architecture:** 13a and 13b carry everything shared: `Transport`/`FakeTransport`, `send_json`/`get`, `percent_encode`, `issue_query`, `strip_repo_qualifiers`, `HostingStore` + `with_token`, `run_blocking`, the `["hosting", …]` query keys, `usePagedQuery`, `useHostingAccounts`, `AccountsDialog`, `hostingMessage`. 13c adds one provider call per host (list the account's repositories), one `HostedRepo` DTO, one command, one IPC wrapper and key, a `RepoBrowser` component with its hook, a tab strip in `CloneDialog`, and one persisted preference.

**Tech Stack:** Rust (`ureq` 3 behind `Transport`, `serde_json`), Tauri 2 commands through `run_blocking`, React 19 + TypeScript, TanStack Query 5, zustand (persist), CSS modules, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-22-gr13-hosting-integration-design.md` (slice 13c: §2 row 13c, §4.1, §4.4 row c, §5.5, §6 items 3–4, §7, §8). The 13a plan `docs/superpowers/plans/2026-10-22-gr13a-hosting-accounts-prs.md` and the 13b plan `docs/superpowers/plans/2026-10-24-gr13b-create-pr-issues.md` record the shared constraints and decisions this plan builds on.

## Global Constraints

- **Everything in the 13a and 13b plans' Global Constraints still holds** (test-first by the test role, the IPC seam, `git2` without network, no `tokio`/`reqwest`, `run_blocking`, the secrets rules, headers, status mapping, redaction, copy rules, the 100 % coverage gate). This section lists only what 13c adds.
- **No new dependencies.** No new `GitError` variants, `AppErrorKind`s or TS kinds.
- **Endpoints** (`{base}`, `enc(x)` = `percent_encode(x)` as in 13a; `{page}` 1-based; page size **50**; `{q}` = the user's query after `issue_query` (trim); `{login}` = `account.username`):
  - GitHub, blank query: `GET {base}/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=50&page={page}` → a JSON array. Non-blank query: `GET {base}/search/repositories?q={enc("{q'} in:name user:{login}")}&sort=updated&order=desc&per_page=50&page={page}` → `items[]`, where `{q'}` = `strip_repo_qualifiers({q})`; when `{q'}` is blank after stripping, the blank-query endpoint is used instead.
  - GitLab: `GET {base}/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=50&page={page}` plus `&search={enc(q)}` when `{q}` is non-blank → a JSON array.
  - Bitbucket: `GET {base}/repositories?role=member&sort=-updated_on&pagelen=50&page={page}` plus `&q={enc(filter)}` with `filter` = `name ~ "{q'}"` where `{q'}` = `{q}` with every `"` and `\` removed, only when `{q'}` is non-blank → `values[]`.
- **JSON mapping** → `HostedRepo { full_name, name, owner, description: Option<String>, private: bool, updated_at: i64, https_url, ssh_url: Option<String>, web_url }` (missing non-optional field → `HostingUnreachable { message: "unexpected response from <host>" }`; an empty `description` string → `None`):
  - GitHub: `full_name`, `name`, `owner.login`, `description`?, `private`, `updated_at`, `clone_url`, `ssh_url`?, `html_url`
  - GitLab: `path_with_namespace`, `path`, `namespace.full_path`, `description`?, `private` = `visibility` ≠ `"public"` (`visibility` missing → `true`), `last_activity_at`, `http_url_to_repo`, `ssh_url_to_repo`?, `web_url`
  - Bitbucket: `full_name`, `name`, `workspace.slug`, `description`?, `is_private`, `updated_on`, `links.clone[]`: the `href` whose `name` is `"https"` (required) and the one whose `name` is `"ssh"` (optional), `links.html.href`
- **Clone-URL validation** (`hosting::model::HostedRepo` construction, all providers): `https_url` must parse as `https://<host>/<path>` with a non-empty host, no userinfo and no whitespace or control character after stripping any `user@` userinfo (Bitbucket sends `https://<user>@bitbucket.org/…`); otherwise the repository row is dropped from the page (not an error). `ssh_url` is kept only when it matches `^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$` or starts with `ssh://` and contains no whitespace or control character; otherwise `None`.
- **Query scoping:** the GitHub search path runs the query through `strip_repo_qualifiers` so `user:`/`org:`/`repo:` typed by the user cannot widen the search past the account.
- **Wire shapes (camelCase):** `HostedRepo { fullName, name, owner, description, private, updatedAt, httpsUrl, sshUrl, webUrl }`.
- **Command** (JS args camelCase): `hosting_list_my_repos { accountId, query, page }` → `HostedRepo[]`; an unknown `accountId` → `NoHostingAccount`; `page` is clamped to ≥ 1. The command never needs a repository id.
- **TS wrapper:** `hostingListMyRepos(accountId, query, page)`; it sends every key.
- **Query key:** `queryKeys.myRepos(accountId, query) = ["hosting", "myRepos", accountId, query]` (connect/disconnect already invalidate `["hosting"]`).
- **`usePagedQuery` gains a key function:** `usePagedQuery<T>(queryKey, fetchPage, enabled, keyOf: (item: T) => string | number)`; the `T extends { number: number }` bound goes away, and `useIssues` and `usePullRequests` pass `(i) => i.number`. Behaviour otherwise unchanged (page size 50, first occurrence wins, no refetch on focus).
- **Persisted preference:** `layoutPrefs` gains `cloneUrlForm: "https" | "ssh"` (default `"https"`) with `setCloneUrlForm`, included in `partialize` (zustand `persist` → `localStorage`, spec §5.5).
- **Copy (verbatim; ‹…› are values):**
  - tabs: tablist accessible name `Clone source`; tabs `URL`, `From account`
  - no account: `Connect a hosting account to browse your repositories` + button `Hosting accounts…` (opens `AccountsDialog`, nested, as the Issues panel does)
  - account picker (only with 2+ accounts): label `Account`; option text `‹username› on ‹host›`
  - reconnect: `Token expired or revoked — reconnect` + `Reconnect` (opens `AccountsDialog`)
  - search: input accessible name `Search repositories`, placeholder `Type to search`; `Loading repositories…`; `No repositories match` (non-blank query) / `No repositories` (blank); `Show more` / busy `Loading…`
  - row: button accessible name `Use ‹fullName›`; shows `‹name›`, `‹owner›`, badge `Private` (when private), the description, `Updated ‹relative time›` using the helper `PullRequestRow` already uses
  - URL form: radiogroup accessible name `Clone with`; radios `HTTPS`, `SSH`; hint when the picked repository has no SSH URL and SSH is selected: `This repository has no SSH URL; HTTPS was used`
  - errors: `hostingMessage(error, provider)` inside `NetworkError` with dismiss = refetch (as the Issues panel)
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing; from the root: `npm run test:coverage` at 100 % statements/branches/functions/lines, `npm run lint`, `npm run typecheck`, `npx prettier --check .`.

## Review Focus

1. **A clone URL that carries userinfo or junk.** Bitbucket's HTTPS clone link is `https://<user>@bitbucket.org/w/s.git`; the user must get `https://bitbucket.org/w/s.git`, and a link with whitespace, a control character or a non-https scheme must drop the row rather than reach `git clone` (Task 1 test `clone_urls_are_sanitized_before_they_can_reach_git`).
2. **A search that tries to widen the scope.** Typing `user:other login` on GitHub must search `login in:name user:<login>`; quotes, `#`, `&` and spaces are percent-encoded on every provider; on Bitbucket `"` and `\` are stripped so the `name ~ "…"` literal cannot be closed (Task 1 test `repo_queries_are_scoped_and_encoded_for_every_provider`).
3. **SSH chosen for a repository with no SSH URL.** The URL field gets the HTTPS URL and the hint appears; switching the preference later re-fills the field for the picked repository (Task 3 test `falls back to HTTPS with a hint when the repository has no SSH URL`).
4. **The selected account needs a reconnect, or every account is disconnected while the tab is open.** No provider call is made; the reconnect notice or the no-account notice is shown; a pick already made stays in the URL field (Task 3 tests `shows the reconnect notice without requesting repositories` and `shows the connect notice when the last account disappears`).
5. **A repository on two pages.** A repository whose update time moved it between page 1 and page 2 appears once (Task 3 test `dedupes repositories across pages by full name` in `useMyRepos.test.tsx`, through the new `keyOf`).

## Deviations and calls (decided here; the implementer does not reopen them)

- **The command returns a plain `HostedRepo[]` page**, not the spec's `{ repos, next_page? }`: every other hosting list uses the 50-per-page rule (`hasMore` = a full page), and `usePagedQuery` already implements it. Recorded as a deviation from §4.4.
- **GitHub search covers the account's own repositories only** (`user:<login>`); collaborator and organization repositories appear in the blank-query list (affiliation `owner,collaborator,organization_member`) but not in a search, because GitHub's search API has no "repositories I can access" qualifier. Recorded as a known limitation; GitLab (`membership=true`) and Bitbucket (`role=member`) search everything the account can see.
- **Rows with an unusable HTTPS URL are dropped, not errors.** One odd repository must not hide the rest of the page.
- **Account lookup by id** is a new `HostingStore::account(id: &str) -> Option<Account>` (filter over `accounts()`); the command maps `None` to `NoHostingAccount`.
- **Layout:** the tab strip sits above the form. The `URL` tab panel holds the existing Repository URL field; the `From account` tab panel holds the browser; the destination chooser, progress, error and the Cancel/Clone actions stay below both panels and are shared. Picking a repository writes the URL state, activates the `URL` tab and focuses the URL input, so the user sees what was filled and the existing destination/clone flow continues unchanged.
- **The `From account` tab always exists**; with no connected account its panel shows the connect notice and `Hosting accounts…`. The dialog does not hide the tab based on accounts, so the entry point is discoverable.
- **The account picker defaults to the first account** (as `useHostingAccounts` orders them); the selection is dialog-local state, not persisted. The HTTPS/SSH preference is persisted (spec).
- **Relative time** reuses the helper `PullRequestRow` uses; no new formatter.
- **No new dependency and no clone-command change:** `clone_repo` already resolves `NetworkAuth::Accounts` for the URL, so a private HTTPS clone uses the account token; SSH clones use the user's agent as before.

---

### Task 1: Core — `HostedRepo` and `list_my_repos` for the three providers

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/hosting/model.rs` (`HostedRepo` + `HostedRepo::new` validation), `hosting/github.rs`, `hosting/gitlab.rs`, `hosting/bitbucket.rs` (`list_my_repos` each), `hosting/mod.rs` (dispatcher by `account.provider`; re-export `HostedRepo`)
- Create (test role): `src-tauri/crates/git-real-core/tests/fixtures/hosting/{github_user_repos,github_search_repos,gitlab_projects,bitbucket_repositories}.json`
- Modify (test role): `tests/hosting_providers.rs`

**Interfaces:**

- Consumes (verified in code): `http::{get, send_json, percent_encode, parse_timestamp, unexpected, issue_query}`, `github::strip_repo_qualifiers` (private to `github.rs`, where the GitHub `list_my_repos` also lives), `Provider::api_base(host)`, `model::Account { provider, host, username, … }`.
- Produces:

```rust
// hosting/model.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct HostedRepo { pub full_name: String, pub name: String, pub owner: String, pub description: Option<String>, pub private: bool, pub updated_at: i64, pub https_url: String, pub ssh_url: Option<String>, pub web_url: String }
impl HostedRepo {
    /// `None` when `https_url` is unusable (see Global Constraints); strips userinfo, drops a bad `ssh_url`, maps "" description to None.
    pub fn sanitized(self) -> Option<HostedRepo>;
}
// hosting/{github,gitlab,bitbucket}.rs — each:
pub fn list_my_repos(t: &dyn Transport, account: &Account, token: &Token, query: &str, page: u32) -> Result<Vec<HostedRepo>, GitError>;
// hosting/mod.rs
pub fn list_my_repos(t: &dyn Transport, account: &Account, token: &Token, query: &str, page: u32) -> Result<Vec<HostedRepo>, GitError>;
pub use model::HostedRepo;
```

- [ ] **Step 1: Write the fixtures** (`tests/fixtures/hosting/`, trimmed to the fields used, each ending with a newline)

| File                          | Content (shape)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_user_repos.json`      | array of 3: `{"full_name":"octo/git-real","name":"git-real","owner":{"login":"octo"},"description":"A Git client","private":false,"updated_at":"2026-10-24T18:00:00Z","clone_url":"https://github.com/octo/git-real.git","ssh_url":"git@github.com:octo/git-real.git","html_url":"https://github.com/octo/git-real"}`; one private repo with `"description":null` and no `ssh_url`; one with `"clone_url":"javascript:alert(1)"` (must be dropped) |
| `github_search_repos.json`    | `{"total_count":1,"items":[ <the first repo above> ]}`                                                                                                                                                                                                                                                                                                                                                                                             |
| `gitlab_projects.json`        | array of 2: `{"path_with_namespace":"group/sub/app","path":"app","namespace":{"full_path":"group/sub"},"description":"","visibility":"private","last_activity_at":"2026-10-23T09:15:00.000Z","http_url_to_repo":"https://gitlab.com/group/sub/app.git","ssh_url_to_repo":"git@gitlab.com:group/sub/app.git","web_url":"https://gitlab.com/group/sub/app"}`; one `"visibility":"public"` without `ssh_url_to_repo`                                  |
| `bitbucket_repositories.json` | `{"values":[{"full_name":"ws/site","name":"site","workspace":{"slug":"ws"},"description":"Docs site","is_private":true,"updated_on":"2026-10-22T07:00:00.000000+00:00","links":{"clone":[{"name":"https","href":"https://octo@bitbucket.org/ws/site.git"},{"name":"ssh","href":"git@bitbucket.org:ws/site.git"}],"html":{"href":"https://bitbucket.org/ws/site"}}}]}`                                                                              |

- [ ] **Step 2: Write the failing tests** in `tests/hosting_providers.rs` (same style as `list_issues_for_each_provider`; `FakeTransport::reply`, `requests()[0].url`):

  - `my_repos_for_each_provider`: blank query → the three URLs from Global Constraints (GitHub `/user/repos?affiliation=…&page=1`, GitLab `/projects?membership=true…`, Bitbucket `/repositories?role=member…` with no `q`), and the mapped `HostedRepo`s: GitHub page has **2** rows (the `javascript:` row dropped), the private one has `description: None, ssh_url: None`; GitLab `owner == "group/sub"`, `private == true`, `description: None` for `""`; Bitbucket `https_url == "https://bitbucket.org/ws/site.git"` (userinfo stripped), `owner == "ws"`.
  - `repo_queries_are_scoped_and_encoded_for_every_provider`: query `user:other "lo gin" #1 & x` → GitHub URL is `/search/repositories?q=` + `enc("\"lo gin\" #1 & x in:name user:octo")` + `&sort=updated&order=desc&per_page=50&page=2` and parses `items`; GitLab `&search=` + `enc("user:other \"lo gin\" #1 & x")`; Bitbucket `&q=` + `enc("name ~ \"user:other lo gin #1 & x\"")`.
  - `github_blank_after_stripping_lists_instead_of_searching`: query `-user:x` → the `/user/repos` URL.
  - `clone_urls_are_sanitized_before_they_can_reach_git`: unit tests on `HostedRepo::sanitized`: `https://u@h/p.git` → `https://h/p.git`; `https://h/p.git` unchanged; `http://h/p.git`, `https:///p`, `https://h/p\n.git`, `javascript:alert(1)` → `None`; `ssh_url` `git@h:p.git` kept, `ssh://git@h/p.git` kept, `git@h:p .git` → `None`, `ftp://x` → `None`; `description: Some("")` → `None`.
  - `my_repos_pages_and_errors_like_the_other_lists`: page 3 appears in every URL; a 401 reply → `HostingAuth`.

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `src-tauri`): `cargo test -p git-real-core --test hosting_providers my_repos`
Expected: compile error (`HostedRepo`, `list_my_repos` missing).

- [ ] **Step 4: Implement** `HostedRepo` + `sanitized` in `model.rs`; `list_my_repos` in each provider module (private wire structs; GitHub chooses the list or search URL per the query; every row goes through `sanitized()` and `None` rows are skipped); the dispatcher and re-export in `mod.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `src-tauri`): `cargo test -p git-real-core --test hosting_providers` and `cargo clippy --workspace --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/git-real-core/src/hosting src-tauri/crates/git-real-core/tests
git commit -m "feat(core): GR-13c list the account's repositories on GitHub, GitLab and Bitbucket"
```

### Task 2: App layer — `hosting_list_my_repos`, the IPC seam, `usePagedQuery` key function

**Files:**

- Modify: `src-tauri/src/hosting_store.rs` (`account(id)`), `src-tauri/src/commands/hosting.rs` (`hosting_list_my_repos_inner`, `hosting_list_my_repos`), `src-tauri/src/lib.rs` (register), `src/lib/ipc/types.ts` (`HostedRepo`), `src/lib/ipc/commands.ts` (`hostingListMyRepos`), `src/lib/query/keys.ts` (`myRepos`), `src/features/hosting/usePagedQuery.ts` (`keyOf`), `useIssues.ts`, `usePullRequests.ts` (pass `(i) => i.number`)
- Modify (test role): `src-tauri/tests/hosting_commands.rs`, `src/lib/ipc/commands.test.ts`, `src/lib/query/keys.test.ts`, `src/features/hosting/usePagedQuery.test.tsx`

**Interfaces:**

- Consumes: Task 1's `hosting::list_my_repos` and `HostedRepo`; `with_token`, `run_blocking`, the `State<Arc<dyn Transport>>` pattern of `hosting_list_issues`.
- Produces:

```rust
// hosting_store.rs
impl HostingStore { pub fn account(&self, id: &str) -> Option<Account>; }
// commands/hosting.rs
pub fn hosting_list_my_repos_inner(store: &HostingStore, t: &dyn Transport, account_id: &str, query: &str, page: u32) -> Result<Vec<HostedRepo>, AppError>;
#[tauri::command] pub async fn hosting_list_my_repos(hosting: State<'_, Arc<HostingStore>>, transport: State<'_, Arc<dyn Transport>>, account_id: String, query: String, page: u32) -> Result<Vec<HostedRepo>, AppError>;
```

```ts
// src/lib/ipc/types.ts
export interface HostedRepo { fullName: string; name: string; owner: string; description: string | null; private: boolean; updatedAt: number; httpsUrl: string; sshUrl: string | null; webUrl: string }
// src/lib/ipc/commands.ts
export function hostingListMyRepos(accountId: string, query: string, page: number): Promise<HostedRepo[]>;
// src/lib/query/keys.ts
myRepos: (accountId: string, query: string) => ["hosting", "myRepos", accountId, query] as const,
// src/features/hosting/usePagedQuery.ts
export function usePagedQuery<T>(queryKey: QueryKey, fetchPage: (page: number) => Promise<T[]>, enabled: boolean, keyOf: (item: T) => string | number): PagedQuery<T>;
```

- [ ] **Step 1: Write the failing tests**

  - `src-tauri/tests/hosting_commands.rs` (in-memory `TokenStore`, `FakeTransport`, as the `hosting_list_issues` tests): `list_my_repos_uses_the_account_token_and_pages` (the request carries `Authorization: Bearer <token>`, page 0 → `page=1` in the URL, returns the mapped rows); `list_my_repos_with_an_unknown_account_is_no_hosting_account` (`AppErrorKind::NoHostingAccount`, no request sent); `list_my_repos_marks_the_account_for_reconnect_on_401` (`needs_reconnect` true afterwards).
  - `commands.test.ts`: `hostingListMyRepos` invokes `hosting_list_my_repos` with `{ accountId, query, page }`.
  - `keys.test.ts`: `queryKeys.myRepos("github:github.com:octo", "git")` equals `["hosting", "myRepos", "github:github.com:octo", "git"]`.
  - `usePagedQuery.test.tsx`: `dedupes by the given key function` (string keys, first occurrence wins) and the existing tests updated to pass `(i) => i.number`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --test hosting_commands list_my_repos` (from `src-tauri`); `npx vitest run src/lib src/features/hosting/usePagedQuery.test.tsx`
Expected: compile errors / failing assertions on the missing command, wrapper, key and parameter.

- [ ] **Step 3: Implement** the store lookup, the inner function (`store.account(id).ok_or(NoHostingAccount)`, then `with_token(store, &account, |t| hosting::list_my_repos(…, page.max(1)))`), the command through `run_blocking`, the registration, the TS type, wrapper and key, and the `keyOf` parameter (update the two callers).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace` (from `src-tauri`); `npx vitest run src/lib src/features/hosting`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src-tauri/tests src/lib src/features/hosting/usePagedQuery.ts src/features/hosting/useIssues.ts src/features/hosting/usePullRequests.ts
git commit -m "feat: GR-13c hosting_list_my_repos command, IPC wrapper, paged-query key function"
```

### Task 3: Front end — repository browser, clone dialog tabs, URL form preference

**Files:**

- Create: `src/features/hosting/useMyRepos.ts`, `src/features/hosting/RepoBrowser.tsx`, `src/features/hosting/RepoBrowser.module.css`, `src/features/hosting/cloneUrlFor.ts`
- Modify: `src/features/repo/CloneDialog.tsx` (+ `.module.css`: tab strip), `src/lib/store/layoutPrefs.ts` (`cloneUrlForm`)
- Create (test role): `src/features/hosting/useMyRepos.test.tsx`, `RepoBrowser.test.tsx`, `cloneUrlFor.test.ts`
- Modify (test role): `src/features/repo/CloneDialog.test.tsx`, `src/lib/store/layoutPrefs.test.ts`, `src/test/hostingFixtures.ts` (a `hostedRepo()` factory)

**Interfaces:**

- Consumes: Task 2's `hostingListMyRepos`, `HostedRepo`, `queryKeys.myRepos`, `usePagedQuery(…, keyOf)`; `useHostingAccounts`, `AccountsDialog`, `NetworkError`, `hostingMessage`, `RECONNECT_TEXT`, `PROVIDER_LABEL`, the relative-time helper used by `PullRequestRow`, `useRestoreFocus` conventions from `IssuePicker` for the nested dialog.
- Produces:

```ts
// useMyRepos.ts
export interface UseMyRepos { repos: HostedRepo[] | undefined; error: AppError | null; hasMore: boolean; fetching: boolean; loadingMore: boolean; refetch(): void; loadMore(): void }
export function useMyRepos(accountId: string | null, query: string, enabled: boolean): UseMyRepos; // enabled && accountId !== null gates the query; keyOf = (r) => r.fullName
// cloneUrlFor.ts
export type CloneUrlForm = "https" | "ssh";
/** The URL in the preferred form, and whether it fell back to HTTPS because the repo has no SSH URL. */
export function cloneUrlFor(repo: HostedRepo, form: CloneUrlForm): { url: string; fellBack: boolean };
// RepoBrowser.tsx
export interface RepoBrowserProps { onPick(url: string): void; disabled: boolean }
export function RepoBrowser(props: RepoBrowserProps): JSX.Element;
// layoutPrefs.ts
cloneUrlForm: CloneUrlForm; setCloneUrlForm(form: CloneUrlForm): void; // default "https", persisted
```

- [ ] **Step 1: Write the failing tests**

  - `cloneUrlFor.test.ts`: https → `httpsUrl`, no fallback; ssh with `sshUrl` → `sshUrl`; ssh with `sshUrl: null` → `httpsUrl`, `fellBack: true`.
  - `layoutPrefs.test.ts`: `cloneUrlForm` defaults to `"https"`, `setCloneUrlForm("ssh")` persists (present in the partialized state).
  - `useMyRepos.test.tsx` (mock `src/lib/ipc`): `requests page 1 for the account and query`; `does not request when disabled or without an account`; `dedupes repositories across pages by full name` (Review Focus 5).
  - `RepoBrowser.test.tsx` (mock `src/lib/ipc`; fake timers with `fireEvent` for the debounce): no accounts → connect notice + `Hosting accounts…` opens the accounts dialog; one account → no `Account` picker, rows listed with `Private` badge, owner, description, `Updated …`; two accounts → picker with `‹username› on ‹host›` options, switching re-queries; typing debounces 300 ms then requests with the trimmed query (`requests once after the debounce`); `Show more` loads page 2; `Use octo/git-real` calls `onPick` with the HTTPS URL by default and the SSH URL after choosing `SSH`; `falls back to HTTPS with a hint when the repository has no SSH URL` (Review Focus 3); `shows the reconnect notice without requesting repositories` for a `needsReconnect` account (Review Focus 4); provider error → `NetworkError` with the hosting copy and dismiss refetches; `disabled` disables the search, radios and row buttons.
  - `CloneDialog.test.tsx`: tablist `Clone source` with `URL` selected by default and the URL field shown; `From account` shows the browser (mock `hostingListAccounts`); picking a repository fills the Repository URL field, activates `URL`, focuses the field, and `Destination:` derives from the URL as today; `shows the connect notice when the last account disappears` (accounts query refetches to `[]` while the tab is open; a filled URL stays) (Review Focus 4); Escape and Cancel still close; tabs are disabled while cloning.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/hosting src/features/repo src/lib/store`
Expected: failures on missing modules, props and copy.

- [ ] **Step 3: Implement** `cloneUrlFor`, the `layoutPrefs` field, `useMyRepos` on `usePagedQuery`, `RepoBrowser` (account `<select>` only with 2+ accounts; debounced search as `IssuePicker`; `usePagedQuery` list with `Show more`; `Clone with` radiogroup bound to `layoutPrefs.cloneUrlForm`; row buttons call `onPick(cloneUrlFor(repo, form).url)` and show the fallback hint), and the tab strip in `CloneDialog` (WAI-ARIA tabs: `role="tablist"` with arrow-key movement between two `role="tab"` buttons, `aria-selected`, `aria-controls`, each panel `role="tabpanel"`; the shared destination/progress/error/actions block below).

- [ ] **Step 4: Run the gate**

Run: `npm run test:coverage` (100/100/100/100), `npm run lint`, `npm run typecheck`, `npx prettier --check .`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/features/hosting src/features/repo src/lib/store src/test
git commit -m "feat(ui): GR-13c clone dialog browses the account's repositories"
```

## Execution: batched agent cycles

Two cycles, to keep the agent count low (the user is cost-sensitive):

- **Cycle 1 = Tasks 1 + 2** (core + app layer + IPC seam + `keyOf`): architect pre-flight (opus) + tdd-tester (sonnet) in parallel → developer (opus) → tdd-tester-coverage (sonnet) + code-reviewer (sonnet) in parallel → fix round(s) → architect sign-off.
- **Cycle 2 = Task 3** (front end): the same shape. The tester may start Task 3's red tests as soon as Task 2's wire shapes are committed.
- Then the final whole-branch review (opus), the lead's gate re-run, and the acceptance walk. Expected dispatches: about 10 agents plus re-uses for re-reviews and sign-offs.

Branch: `feature/gr-13c-clone-browser` from `main`. Commits carry the noreply author email (repo-local config) or GitHub rejects the push.

## Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing. From the root: `npm run test:coverage` at 100 % on all four measures, `npm run lint` (0 errors), `npm run typecheck`, `npx prettier --check .`. Plus the coverage agent's confirmation and the architect's explicit approval.

## Acceptance walk (after the gate, in the dev app with the connected `harmonizationllc` GitHub account)

1. Start screen → **Clone repository** → **From account**: no account picker (one account); the list shows `test-repo` and `git-real` with owner `harmonizationllc`, `Updated …`, no `Private` badge for public repos.
2. Type `test` → after the debounce the list narrows to `test-repo`; clear → full list again.
3. **Use harmonizationllc/test-repo** → the `URL` tab activates with `https://github.com/harmonizationllc/test-repo.git` in the field and focus on it; **Choose folder** (scratchpad) → `Destination: …/test-repo`; **Clone** → progress, then the repository opens.
4. Reopen the dialog, pick **SSH**, pick a repository → `git@github.com:harmonizationllc/….git`; close the app and reopen → **SSH** is still selected (persisted).
5. Disconnect the account (Hosting accounts…) and reopen **From account** → the connect notice with **Hosting accounts…**; reconnect.
6. Clean up: delete the cloned folder from the scratchpad and remove it from the recent list.

GitLab and Bitbucket rest on the fixture tests unless the user has accounts there (spec §8).
