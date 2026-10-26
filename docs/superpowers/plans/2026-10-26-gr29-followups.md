# GR-29 follow-ups — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fifteen minor findings the GR-29 whole-branch review left as follow-ups, on the same branch, before merge.

**Architecture:** No design change. Three batched cleanup tasks (Rust, front end, docs), each a set of small same-shape edits with their tests. Behaviour stays within spec `docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md`; only item 4 of the review (remembering the un-maximized size across a resize-while-maximized session) is deliberately not done, because spec §5 sanctions today's behaviour and a fix needs resize tracking.

**Tech Stack:** Rust (serde, std), Tauri 2.12, React 18 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md` (§3, §5, §7) and the final review's findings 5–18 (archived outside the repo; each is restated below with its file).

## Global Constraints

- No behaviour change beyond the items listed; no new crates or dependencies.
- `git-real-core` has no Tauri dependency. Only `src/lib/ipc` imports `@tauri-apps/api/core`.
- Tests first for every behavioural item; a pure test addition is its own red→green.
- Gate per task: Rust tasks `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check` from `src-tauri`; front-end task full `npm test`, `npm run typecheck`, `npm run lint` (0 errors; one pre-existing `DiffViewer.tsx` warning is accepted), coverage 100 % on touched files; docs task `npm run lint`.
- Commits: explicit paths only, never `-A`, never amend/reset/stash. Subjects `fix(GR-29): …`, `test(GR-29): …`, `docs(GR-29): …`; trailers from the session's attribution reminder.
- Models: Task 1 → `opus`; Tasks 2, 3 → `sonnet`; scoped re-reviews → `sonnet`.

## Review Focus

1. A fullscreen window at close must not store the screen size as the window size. → Task 1.
2. A `settings.json` leaf with a relative path in Load mode must never panic. → Task 1.
3. The clone-directory alert must not flash for a directory the user just picked. → Task 2.

---

### Task 1: Rust hardening and tests

**Files:**

- Modify: `src-tauri/src/main_window.rs` (`on_close_requested`), `src-tauri/src/lib.rs` (close handler), `src-tauri/crates/git-real-core/src/settings.rs`
- Modify: `src-tauri/tests/main_window.rs`, `src-tauri/tests/settings_store.rs`, `src-tauri/tests/git_cli_probe.rs`, `src-tauri/tests/tools_commands.rs`, `src-tauri/crates/git-real-core/tests/settings.rs`
- Modify or create: `src-tauri/tests/common/mod.rs` (shared fake-git helper)

**Interfaces:**

- Produces: `tests/common/mod.rs::fake_git(dir: &Path) -> PathBuf` (the ETXTBSY-retrying fake Git script the three test files currently each define as `fake_git` / `common_fake_git` / `fake_git_path`); `main_window::on_close_requested` unchanged signature.

- [ ] **Step 1 — fullscreen guard (review 5).** Test in `tests/main_window.rs` only if a pure function is extracted; otherwise document in the function. In `on_close_requested`, read `window.is_fullscreen()`; when `Ok(true)`, return without saving (fullscreen is not a stored state, spec §5). Any `Err` logs and returns as today.
- [ ] **Step 2 — label guard (review 6).** In `lib.rs`'s `on_window_event`, save geometry only when `window.label() == main_window::LABEL`.
- [ ] **Step 3 — strict `Deserialize` (review 13).** In `settings.rs`, remove `Deserialize` from `SettingsFile`'s derive if nothing needs it (grep the workspace; `parse` reads a `serde_json::Value`); if something does, keep it and add a doc line `Never deserialize this directly; use parse`. Run the core tests.
- [ ] **Step 4 — infallible Load (review 14).** Replace the `unreachable!` in the Load path with a fallback to the leaf's default plus a `SettingsWarning`, so Load cannot panic by construction. Test: `lenient_relative_paths_never_panic` feeding relative paths to both path leaves and asserting defaults + warnings (may already exist under another name; extend rather than duplicate).
- [ ] **Step 5 — Load-mode type gaps (Task 2 ledger).** Tests in core `tests/settings.rs`: `lenient_u32_overflow_and_negative_fall_back` (`refsWidth: 4294967296` and `-5` → 240 + warning each), `lenient_non_object_section_falls_back` (`"layout": 5` → defaults for the section, one warning on `layout`), `lenient_null_on_non_nullable_leaf_falls_back` (`"diff": {"mode": null}` → `split` + warning). Extend `lenient_clamps_font_size_and_widths` to assert the warning fields (`appearance.diffFontSize`, `layout.refsWidth`, `layout.sidebarWidth`, `window`).
- [ ] **Step 6 — geometry tests (review 17).** In `tests/main_window.rs`: `logical_geometry_rounds_fractional_scale` ((1600, 1000), 1.25 → 1280 × 800), `logical_geometry_treats_zero_scale_as_one` ((1280, 800), 0.0 → 1280 × 800). In `tests/settings_store.rs`: `set_window_save_failure_leaves_memory_unchanged` (unwritable directory → `Err`, `store.get().window` unchanged) and `load_logs_the_warning_text` if the warning text can be captured (if `eprintln!` cannot be captured, skip and say so).
- [ ] **Step 7 — shared fake-git helper (ledger).** Move the fake Git script into `tests/common/mod.rs` as `fake_git`, name the magic errno (`ETXTBSY = 26`) as a constant with a comment, and make `git_cli_probe.rs`, `settings_store.rs`, `tools_commands.rs` use it (`mod common;`). No behaviour change.
- [ ] **Step 8 — gate** from `src-tauri`: `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --check`.
- [ ] **Step 9 — commit** with explicit paths → `fix(GR-29): fullscreen and label guards on close, infallible lenient load, shared fake-git test helper, geometry and load tests`.

---

### Task 2: Front-end hardening, polish and tests

**Files:**

- Modify: `src/lib/store/settings.ts`, `src/lib/store/settingsActions.ts`, `src/features/settings/SettingsDialog.tsx`, `src/app/applyAppearance.ts` (only if a test needs a seam)
- Modify: `src/lib/store/settings.test.ts`, `src/lib/store/settingsActions.test.ts`, `src/features/settings/SettingsDialog.test.tsx`, `src/app/applyAppearance.test.ts`, `src/features/palette/CommandPalette.test.tsx`, `src/test/settingsStore.ts`

**Interfaces:**

- Consumes: `LayoutColumn` from `src/app/layout.ts`; `queryKeys.settingsHealth`; `useSettings`.

- [ ] **Step 1 — `readInjectedSettings` rejects arrays (review 8).** Test: `readInjectedSettings ignores an array global` → `DEFAULT_SETTINGS`. Add `!Array.isArray(...)`.
- [ ] **Step 2 — `LayoutColumn` reuse (review 9).** `settingsActions.ts` `resetWidth(column: LayoutColumn)` imports the type from `../../app/layout` (or move the type into the store and re-export from `layout.ts` if that import direction creates a cycle; say which).
- [ ] **Step 3 — clone alert during refetch (review 10, Review Focus 3).** Test in `SettingsDialog.test.tsx`: after choosing a folder, while `checkSettingsHealth` is pending, no `Directory not found` alert renders; after it resolves `false`, still none; after it resolves `true`, the alert renders. Hide the alert while `health.isFetching`.
- [ ] **Step 4 — File path placeholder (review 11).** Test: while `settingsFilePath` is pending the span shows `Locating…`; on rejection it shows `Unavailable`; on success the path. Implement with the query's `isPending`/`isError`.
- [ ] **Step 5 — health invalidation after reconcile (review 12).** In the store's `reconcile`, after replacing state, call an injectable `onReconciled` hook OR, simpler and preferred, have `CloneSettings` key its health query on the current `defaultDir` (`queryKey: [...queryKeys.settingsHealth, defaultDir]`) so a reconciled change refetches by key. Test: changing `settings.clone.defaultDir` in the store triggers a new `checkSettingsHealth` call.
- [ ] **Step 6 — typed pending patches and empty sections (ledger).** `PendingEdit.patch` typed per section (`Partial<Settings[S]>`); `setPref` skips a section whose object has no keys (test: `setPref({ layout: {} })` arms no timer and sends nothing).
- [ ] **Step 7 — in-flight-then-rejected overlay test (review 18).** Test in `settings.test.ts`: set a width (send in flight), set the same section again while in flight (pending), reject the in-flight request → the view reverts to `lastKnown` for that section and the pending edit is still sent afterwards (or dropped — assert whichever the code does today and state it in the test name).
- [ ] **Step 8 — bootstrap tests (Task 7 ledger).** In `applyAppearance.test.ts`: the uninstaller unsubscribes (a store change after uninstall does not re-apply) and removes both `pagehide` and `beforeunload` listeners.
- [ ] **Step 9 — test leftovers (ledgers).** Remove the dead `getSettings` mock in `CommandPalette.test.tsx`; reset `lastKnown`/pending in `settingsActions.test.ts` via the shared helper's `resetSettings()`; remove the leftover `queryClient.clear()` in `useExternalTool.test.tsx` if still unused; add one doc sentence to `src/test/settingsStore.ts` that `resetSettings` awaits in-flight requests and would hang on one that never settles.
- [ ] **Step 10 — gate:** full `npm test && npm run typecheck && npm run lint`; coverage 100 % on touched files.
- [ ] **Step 11 — commit** → `fix(GR-29): settings store and dialog hardening with the review's missing tests`.

---

### Task 3: Docs

**Files:**

- Create: `docs/adr/0005-settings-owned-by-rust.md`
- Modify: `docs/adr/0002-project-structure.md` (the window is built in Rust, not declared in `tauri.conf.json`; settings are one Rust-owned file), `docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md` (one logging line in §3 or §8)

- [ ] **Step 1 — ADR 0005** in the style of ADR 0003/0004: context (preferences were split across four `localStorage` stores and a flat v1 file; GR-14 R3), decision (one grouped versioned `settings.json` owned by Rust; the main window built in Rust with the init script; no `localStorage` for preferences; `lastCheckedAt` stays in the browser), consequences (file is a user contract from the first tagged release — every shape change owes a migration; hand edits apply at next launch; geometry saved at close only), alternatives considered (split store, loading screen).
- [ ] **Step 2 — ADR 0002** update the two stale sentences (window entry, settings feature folder) with a pointer to ADR 0005.
- [ ] **Step 3 — logging line** in the spec: lenient-load and window warnings go to stderr (`eprintln!`), which a `.desktop`-launched bundle delivers to the user journal (`journalctl --user`).
- [ ] **Step 4 — gate:** `npm run lint` (Prettier covers markdown) clean.
- [ ] **Step 5 — commit** → `docs(GR-29): ADR 0005 settings owned by Rust; ADR 0002 and spec logging note`.
