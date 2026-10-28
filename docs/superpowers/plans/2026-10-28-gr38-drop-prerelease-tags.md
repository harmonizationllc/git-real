# Drop Pre-Release Tag Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tests first, by the test role; the developer writes the minimum change that makes them pass and never edits test files. Every dispatch: `git add <explicit paths>` only; never `git reset`, `git commit --amend`, `git stash`, `git add -A`, `git add -u`, `git push`. One git command per shell command. Run `git log -3` before committing.

**Goal:** Release tags are `vX.Y.Z` only. The hyphen-means-pre-release convention from GR-15, and GR-24's numeric-only workaround for it, are removed from the workflow, the contract test, the README and ADR 0006.

**Architecture:** Four declarative edits pinned by the existing contract test: the `check-version` regex loses its optional `-N` group, the publish step loses its `prerelease` expression, the README loses its pre-release paragraph, ADR 0006 marks R10 withdrawn. No Rust or TypeScript source changes.

**Tech Stack:** GitHub Actions YAML, Vitest contract test (`src/test/release.test.ts`), Markdown.

**Spec:** none; owner decision in chat on 2026-10-27: "why are we creating tags with hyphens? they are not needed" and "go ahead and fix the hyphen issue". Jira GR-38 step 1 describes the same change. This plan is the full description.

**Branch:** `feature/gr38-drop-prerelease-tags` from `main` (d676663).

## Global Constraints

- Only these files change: `.github/workflows/release.yml`, `src/test/release.test.ts`, `README.md`, `docs/adr/0006-per-platform-bundles-and-release.md`.
- Exact values: guard regex literally `^[0-9]+\.[0-9]+\.[0-9]+$`; guard message `version $tag must be X.Y.Z (release tags carry no pre-release suffix)`; test version regex `/^\d+\.\d+\.\d+$/`; the string `prerelease` must not appear in `release.yml`.
- `npm run lint`, `npm run typecheck`, `npm test` clean before each commit. Commit messages end with the two attribution trailer lines the controller supplies.

## Review Focus

1. **A tag with a hyphen** (`v0.2.0-1` or `v0.2.0-beta.1`) must now be rejected by the guard before any build. Pinned in Task 1: the test asserts the regex text `^[0-9]+\.[0-9]+\.[0-9]+$` is in the script and `(-[0-9]+)?` is not.
2. **A hyphenated version in the three version files** must fail the contract test. Pinned in Task 1 by the tightened version regex.
3. **The publish step** must have no `prerelease` key, so every release is a full release the update check sees. Pinned in Task 1.

---

### Task 1: Tighten the contract tests

**Files:**

- Modify: `src/test/release.test.ts`

**Interfaces:**

- Produces: the red tests Task 2 turns green.

- [ ] **Step 1: Edit the tests**

In `versions`: rename `version is MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-N` to `version is MAJOR.MINOR.PATCH` and assert `toMatch(/^\d+\.\d+\.\d+$/)`; fix the comment above the block (line ~99) to drop "optionally -N".

In `release workflow`: rename `check-version guards the tag and rejects non-numeric pre-release identifiers` to `check-version guards the tag and rejects pre-release suffixes`; keep the `GITHUB_REF_NAME` and `tauri.conf.json` assertions; replace the `(-[0-9]+)?` assertion and its comment with `expect(run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$")` and `expect(run).not.toContain("(-[0-9]+)?")`, with the comment `// Release tags are vX.Y.Z only; no pre-release suffix`.

In `publish downloads both artifacts then releases all five globs once`: replace the `prerelease` assertion with `expect(w).not.toHaveProperty("prerelease")`, and add `expect(readText(".github/workflows/release.yml")).not.toContain("prerelease")`.

In `README`: in `releasing section mentions Windows installers and a numeric pre-release example`, rename to `releasing section mentions Windows installers and no pre-release convention`; keep `toContain("Windows")`; replace the `vX.Y.Z-1` assertion with `expect(section).not.toContain("pre-release")` and keep `not.toContain("-beta")`.

- [ ] **Step 2: Run and confirm red**

Run: `npx vitest run src/test/release.test.ts`
Expected: exactly three failures (`check-version guards…`, `publish downloads…`, `releasing section…`), all AssertionErrors; `version is MAJOR.MINOR.PATCH` passes because the files say `0.1.0`.

- [ ] **Step 3: Lint and commit**

Run: `npm run lint && npm run typecheck`

```bash
git add src/test/release.test.ts
git commit -m "test(GR-38): release tags are vX.Y.Z only; no pre-release suffix or flag"
```

---

### Task 2: Remove the pre-release convention

**Files:**

- Modify: `.github/workflows/release.yml:24,138`
- Modify: `README.md` (`## Releasing`, lines ~233-237)
- Modify: `docs/adr/0006-per-platform-bundles-and-release.md` (R10 bullet ~line 38; Consequences bullet ~line 63)

- [ ] **Step 1: Workflow**

Line 24: replace the `[[ … ]]` test with `[[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version $tag must be X.Y.Z (release tags carry no pre-release suffix)"; exit 1; }`. Line 138: delete the `prerelease:` line.

- [ ] **Step 2: README**

In `## Releasing`, replace the sentences from "A pre-release tag contains a hyphen…" through "…do not prompt users to update." with one sentence: `Release tags are always `vX.Y.Z`; the workflow rejects any other shape, and every release is a full release that the in-app update check can offer.`

- [ ] **Step 3: ADR 0006**

Replace the R10 bullet body with: `**R10 — withdrawn 2026-10-28.** GR-24 required numeric pre-release identifiers (`X.Y.Z-N`) because WiX accepts only numeric version parts. The owner then decided the project cuts no pre-release tags at all, so `check-version`accepts`X.Y.Z`only and the publish step has no`prerelease` flag.` Replace the Consequences bullet "A pre-release tag must look like…" with `Tags are `vX.Y.Z` only; a hyphenated tag fails the version check before any build starts.`

- [ ] **Step 4: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all clean, 46/46 in `src/test/release.test.ts`.

```bash
git add .github/workflows/release.yml README.md docs/adr/0006-per-platform-bundles-and-release.md
git commit -m "feat(GR-38): release tags are vX.Y.Z only; drop the pre-release convention"
```
