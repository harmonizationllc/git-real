# GR-23 macOS Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tests first, by the test role; the developer writes the minimum change that makes them pass and never edits test files. Every dispatch: `git add <explicit paths>` only; never `git reset`, `git commit --amend`, `git stash`, `git add -A`, `git add -u`, or anything that rewrites history. Only Task 3 pushes, and only its own branch. Run `git log -3` before committing.

**Goal:** A `v*` tag publishes one GitHub release carrying a universal macOS `.dmg` beside the Linux and Windows files, CI builds the DMG on every push, and the release job signs and notarizes the moment the six `APPLE_*` repository secrets exist, building unsigned and saying so until then.

**Architecture:** Everything is declarative plus one small bash script. A `tauri.macos.conf.json` overlay names the `dmg` target; `ci.yml` gains `package-macos`; `release.yml` gains `build-macos` with a gate step that runs `.github/scripts/apple-signing-env.sh` to export the Apple variables only when the secrets are non-empty (the Tauri bundler treats an empty variable as set and fails); `publish` gains a sixth glob. Vitest pins the workflows, the overlay, the README and ADR text, and runs the gate script through every branch of its rules. No Rust or TypeScript source changes are expected; the only unknown is whether the app crate compiles and bundles on macOS, which Task 3 proves on CI.

**Tech Stack:** Tauri 2.12 CLI (`npm run tauri build -- --target universal-apple-darwin --bundles dmg`), GitHub Actions (`macos-latest`, `dtolnay/rust-toolchain@stable` with two Apple targets, `actions/upload-artifact@v4`, `softprops/action-gh-release@v2`), bash, Vitest with the `yaml` package and `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-10-28-gr23-macos-build-design.md` (R1–R11 are decided; do not reopen them).

**Branch:** `feature/gr-23-macos-build` from `main` (09b10ce), in a worktree under `.claude/worktrees/gr-23-macos-build`. The spec file is uncommitted on `main` at plan time; Task 1 commits it with the plan on the branch.

**Dispatch:** three tasks, three implementer cycles plus one task review each, then one whole-branch review. Test role (Task 1) and Task 3 on `sonnet`; Task 2 on `sonnet`; task reviews on `sonnet`; the final whole-branch review on `opus` (the GR-24 final review caught a release-breaking glob bug the task reviews had missed).

## Global Constraints

- Commits carry the repo-local noreply author email (`git config user.email` already returns it in this clone; worktrees inherit it). Commit messages end with the attribution lines the session reminder gives.
- No Rust or TypeScript source edits unless Task 3 hits a macOS compile failure, and then only under spec R8: a gate, an import, or a one-line platform branch in `src-tauri/src/`, with a comment; never in `git-real-core`.
- No new npm or Cargo dependency. No Tauri plugin. `tauri.conf.json`, `tauri.linux.conf.json` and `tauri.windows.conf.json` do not change.
- The text `APPLE_` appears nowhere in `ci.yml`, in any `src-tauri/*.json`, or in `release.yml` outside the gate step's `env:` block (R10). The build step after the gate has no `env:` key.
- `npm run lint` (ESLint + Prettier, which also formats the JSON, YAML and Markdown touched here), `npm run typecheck`, `npm test` clean before every commit that touches a file they cover. Run them inside the worktree; the main checkout's lint also walks stale worktree copies and is noisy.
- Exact values, copied from the spec and reused by every task:
  - Build command: `npm run tauri build -- --target universal-apple-darwin --bundles dmg`.
  - Rust setup: `dtolnay/rust-toolchain@stable` with `targets: aarch64-apple-darwin, x86_64-apple-darwin`.
  - DMG glob: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg`.
  - CI upload name `git-real-macos-${{ github.sha }}`, `retention-days: 14`, `if-no-files-found: error`. Job id `package-macos`, display name `Package (macOS)`, `runs-on: macos-latest`.
  - Release upload name `release-macos`, `retention-days: 1`, `if-no-files-found: error`. Job id `build-macos`, `runs-on: macos-latest`, `needs: check-version`. `publish` `needs: [build-linux, build-windows, build-macos]` and lists a sixth glob `release-assets/**/*.dmg`.
  - Gate step name `Prepare Apple signing`, `run: .github/scripts/apple-signing-env.sh`, with an `env:` block mapping exactly `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` to `${{ secrets.<same name> }}`.
  - Gate script notice lines, exact: `::notice::Apple signing: unsigned`, `::notice::Apple signing: signed, not notarized`, `::notice::Apple signing: signed and notarized`. `GITHUB_ENV` heredoc delimiter, exact: `EOF_APPLE_SIGNING`.
  - Overlay `src-tauri/tauri.macos.conf.json`: `$schema` `https://schema.tauri.app/config/2`, `bundle` with the single key `targets: ["dmg"]`.
  - Download file name in the README: `Git.Real_<version>_universal.dmg` (R11, confirmed by Task 3).

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its pinning test added to the owning task below.

1. **A secret set to the empty string** (GitHub's value for an unset secret): the gate must treat it as unset, or the build fails on an empty certificate import. Pinned in Task 1 (`apple-signing-env › empty strings behave as unset`).
2. **A base64 certificate pasted with line breaks**: the value must reach the bundler intact through `GITHUB_ENV`. Pinned in Task 1 (`all six set round-trip, including a multi-line certificate`).
3. **Half-configured secrets** (certificate without password, notarization trio missing the team id, identity alone): the gate must fail naming the missing variable rather than build unsigned or let the bundler fail later. Pinned in Task 1 (the six exit-1 cases).
4. **The DMG downloading to the artifact root, not `dmg/`**: the publish glob must still match. Pinned in Task 1 (`publish downloads all three artifacts then releases all six globs once`), with the comment explaining the single-glob layout.
5. **A universal build writing under `target/universal-apple-darwin/`, not `target/release/`**: an upload glob on the wrong path uploads nothing and `if-no-files-found: error` fails the job on a tag push. Pinned in Task 1 (both macOS job tests assert the `universal-apple-darwin` path).

---

### Task 1: Contract tests for the macOS overlay, workflows, gate script and docs

**Files:**

- Modify: `src/test/release.test.ts`
- Create: `src/test/apple-signing-env.test.ts`
- Commit alongside (already written): `docs/superpowers/specs/2026-10-28-gr23-macos-build-design.md`, `docs/superpowers/plans/2026-10-28-gr23-macos-build.md`

**Interfaces:**

- Consumes: the existing helpers in `release.test.ts` (`readText`, `readJson`, `fileExists`, `Step`, `stepsOf`, `needsOf`, `uploadOf`, `buildRunOf`, the README `section` helper), `yaml`'s `parse`; `execFileSync` from `node:child_process`, `mkdtempSync`/`writeFileSync`/`readFileSync`/`statSync` from `node:fs`, `tmpdir` from `node:os`.
- Produces: the red tests Tasks 2 and 3 turn green. Task 2 relies on the exact names, paths and strings asserted here; they are the spec's values and are listed in Global Constraints.

- [ ] **Step 1: Create the worktree and branch (skip if the orchestrator already did)**

Run, from the main checkout:

```sh
git worktree add -b feature/gr-23-macos-build .claude/worktrees/gr-23-macos-build main
cd .claude/worktrees/gr-23-macos-build && npm ci
```

Copy the spec and this plan into the worktree at the same paths (they are untracked on `main`). Expected: `git status` in the worktree shows the two docs untracked and nothing else.

- [ ] **Step 2: Extend `src/test/release.test.ts`**

Change these blocks; leave `versions`, `bundle config`, `desktop template`, `icon source`, `apt packages` and `bench workflow` untouched. Refresh the file header comment to mention GR-23 beside GR-24.

`platform overlays`

- Both `toEqual(["linux", "windows"])` assertions become `toEqual(["linux", "macos", "windows"])`; the test name becomes `exactly linux, macos and windows overlays exist and each names its targets`.
- New `macos overlay has the dmg target and nothing else`: `overlay("macos").bundle?.targets` `toEqual(["dmg"])`; `Object.keys(overlay("macos").bundle ?? {})` `toEqual(["targets"])`.
- New `macos overlay has no signing keys`: `fileExists("src-tauri/tauri.macos.conf.json")` true; for each of `signingIdentity`, `providerShortName`, `entitlements`: `expect(overlay("macos").bundle?.macOS ?? {}).not.toHaveProperty(key)`. Comment: Tauri's key is `macOS` with a capital OS; signing is decided by the environment alone (spec R4, R5).

`ci workflow`

- `has build-and-test, package-linux, package-windows and package-macos jobs and no package job`: add `toHaveProperty("package-macos")`.
- New `package-macos builds a universal dmg on macos-latest and uploads it`: `runs-on === "macos-latest"`; `name === "Package (macOS)"`; the `dtolnay/rust-toolchain@stable` step's `with.targets` (as a string) contains `aarch64-apple-darwin` and `x86_64-apple-darwin`; the build step's `run` contains `--target universal-apple-darwin` and `--bundles dmg`; no `run` step contains `apt-get`; the upload step has `with.name` containing `git-real-macos-`, `with.path` containing `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg` and not containing `src-tauri/target/release/bundle`, `with["if-no-files-found"] === "error"`, `with["retention-days"] === 14`.
- New `ci workflow never references Apple secrets`: `expect(ciText).not.toContain("APPLE_")`.

`release workflow`

- `has check-version, build-linux, build-windows, build-macos and publish jobs`: sorted keys `toEqual(["build-linux", "build-macos", "build-windows", "check-version", "publish"])`.
- `all builds need check-version and publish needs all three builds`: `needsOf(jobs["build-macos"])` `toEqual(["check-version"])`; `needsOf(jobs["publish"]).sort()` `toEqual(["build-linux", "build-macos", "build-windows"])`.
- New `build-macos builds a universal dmg on macos-latest and uploads release-macos`: the same runs-on, Rust targets, build-step and path assertions as the CI test, with `with.name === "release-macos"` and `with["retention-days"] === 1`.
- New `build-macos gates Apple signing through the script before the build`: `const steps = stepsOf("build-macos")`; `gateIdx` = index of the step whose `run` is `.github/scripts/apple-signing-env.sh` (trimmed) and whose `name` is `Prepare Apple signing`; `buildIdx` = index of the step whose `run` includes `npm run tauri build`; both `>= 0` and `gateIdx < buildIdx`; `Object.keys(steps[gateIdx].env).sort()` `toEqual([the six names, sorted])`; for each name, `steps[gateIdx].env[name] === "${{ secrets." + name + " }}"`; `expect(steps[buildIdx]).not.toHaveProperty("env")`.
- New `release workflow references Apple secrets only in the gate env block`: take `readText(".github/workflows/release.yml")`, drop every line matching `/^\s*APPLE_[A-Z_]+: \$\{\{ secrets\.APPLE_[A-Z_]+ \}\}\s*$/`, and `expect(rest).not.toContain("APPLE_")`.
- `publish downloads all three artifacts then releases all six globs once` (rewrite of the five-glob test): keep the download/release ordering and `with` assertions; keep deriving the five Linux and Windows globs from the upload paths under `src-tauri/target/release/bundle/`; then `expect(files).toContain("release-assets/**/*.dmg")`; `fileLines` `toHaveLength(6)`; keep the flat-glob rejection loop and the single-release-step assertion. Comment above the dmg line: the macOS upload has one glob whose only wildcard is the file name, so `upload-artifact@v4` puts the DMG at the artifact root; `**` matches the root and a `dmg/` folder alike (spec R7).

`README`

- New `intro no longer calls macOS a follow-on target`: `expect(readme.slice(0, readme.indexOf("\n## "))).not.toMatch(/macOS[^.\n]*follow-on/)`.
- New `install section documents the universal DMG and the Gatekeeper path`: `section(readme, "Install")` contains `.dmg`, `universal`, `Git.Real_` and `Open Anyway`.
- `releasing section mentions Windows installers and no pre-release convention` gains `toContain("macOS")` and `toContain("six")`.
- New `development section has a macOS build paragraph`: `section(readme, "Development")` contains `Building on macOS`.
- `ADR 0006 exists and ADR 0003 points to it` gains, on the ADR 0006 text: `toContain("build-macos")`, `toContain("APPLE_CERTIFICATE")`, `toContain("Windows signing stays out of the code")`, `not.toContain("— Signing stays out of the code")`.

- [ ] **Step 3: Create `src/test/apple-signing-env.test.ts`**

Top of file: a comment naming spec R5 and the script path. Helpers, in-file:

- `const SCRIPT = resolve(ROOT, ".github/scripts/apple-signing-env.sh")` with `ROOT` as in `release.test.ts`.
- `const NAMES = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] as const`.
- `function runGate(vars: Partial<Record<(typeof NAMES)[number], string>>, opts?: { noGithubEnv?: boolean }): { status: number; output: string; envFile: string }` — creates a fresh `mkdtempSync(join(tmpdir(), "gr23-"))` dir with an empty `github.env` file, runs `execFileSync("bash", [SCRIPT], { env: { PATH: process.env.PATH ?? "", ...(noGithubEnv ? {} : { GITHUB_ENV: file }), ...vars }, encoding: "utf8", stdio: "pipe" })` inside try/catch, returns status 0 and stdout on success, else the error's `status` and `stdout + stderr`; `envFile` is the file's content after the run. No environment inheritance beyond `PATH`.
- `function parseGithubEnv(text: string): Record<string, string>` — matches every `NAME<<EOF_APPLE_SIGNING\n…\nEOF_APPLE_SIGNING` block (`/^([A-Z_]+)<<EOF_APPLE_SIGNING\n([\s\S]*?)\nEOF_APPLE_SIGNING$/gm`) into a map.
- `const hasBash = (() => { try { execFileSync("bash", ["-c", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();` and `describe.skipIf(!hasBash)("apple-signing-env", …)`.

Tests, with `CERT = "MIIabc\nMIIdef"`, `PW = "p12-pass"`, `ID = "Developer ID Application: Harmonization LLC (TEAMID1234)"`, `AID = "owner@example.com"`, `APW = "abcd-efgh-ijkl-mnop"`, `TEAM = "TEAMID1234"`:

- `script exists and is executable`: `statSync(SCRIPT).mode & 0o111` is non-zero.
- `nothing set: unsigned, writes nothing`: `runGate({})` → `status === 0`, `envFile === ""`, `output` contains `::notice::Apple signing: unsigned`.
- `empty strings behave as unset`: all six set to `""` → same three assertions as above.
- `all six set round-trip, including a multi-line certificate`: `status === 0`; `parseGithubEnv(envFile)` `toEqual({ APPLE_CERTIFICATE: CERT, APPLE_CERTIFICATE_PASSWORD: PW, APPLE_SIGNING_IDENTITY: ID, APPLE_ID: AID, APPLE_PASSWORD: APW, APPLE_TEAM_ID: TEAM })`; `output` contains `::notice::Apple signing: signed and notarized`.
- `certificate pair alone signs without notarizing`: `{ APPLE_CERTIFICATE: CERT, APPLE_CERTIFICATE_PASSWORD: PW }` → `status === 0`; parsed keys sorted `toEqual(["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"])`; `output` contains `::notice::Apple signing: signed, not notarized`.
- `identity is optional and exported with the certificate`: pair plus `APPLE_SIGNING_IDENTITY: ID` → `status === 0`; parsed keys sorted equal the three; `output` contains `signed, not notarized`.
- `certificate without its password fails naming the password`: `{ APPLE_CERTIFICATE: CERT }` → `status === 1`; `output` contains `APPLE_CERTIFICATE_PASSWORD`; `envFile === ""`.
- `password without the certificate fails naming the certificate`: `{ APPLE_CERTIFICATE_PASSWORD: PW }` → `status === 1`; `output` contains `APPLE_CERTIFICATE`; `envFile === ""`.
- `identity alone fails naming the certificate`: `{ APPLE_SIGNING_IDENTITY: ID }` → `status === 1`; `output` contains `APPLE_CERTIFICATE`; `envFile === ""`.
- `notarization trio missing the team id fails naming it`: pair plus `APPLE_ID`, `APPLE_PASSWORD` → `status === 1`; `output` contains `APPLE_TEAM_ID`; `envFile === ""`.
- `notarization trio without a certificate fails naming the certificate`: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` only → `status === 1`; `output` contains `APPLE_CERTIFICATE`; `envFile === ""`.
- `missing GITHUB_ENV fails`: `runGate({ APPLE_CERTIFICATE: CERT, APPLE_CERTIFICATE_PASSWORD: PW }, { noGithubEnv: true })` → `status === 1`; `output` contains `GITHUB_ENV`.

The `envFile === ""` assertions on failure pin that the script validates before it writes anything.

- [ ] **Step 4: Run the two files and confirm they fail for the right reasons**

Run: `npx vitest run src/test/release.test.ts src/test/apple-signing-env.test.ts`
Expected: the new and changed tests fail (missing overlay, missing jobs, missing script → `ENOENT` or a non-zero status, README and ADR text absent); every untouched test still passes. `npm run lint && npm run typecheck` clean on the two test files.

- [ ] **Step 5: Commit**

```bash
git add src/test/release.test.ts src/test/apple-signing-env.test.ts docs/superpowers/specs/2026-10-28-gr23-macos-build-design.md docs/superpowers/plans/2026-10-28-gr23-macos-build.md
git commit -m "test(GR-23): macOS overlay, package and build jobs, Apple signing gate, docs"
```

---

### Task 2: Overlay, gate script, workflows and documentation

**Files:**

- Create: `src-tauri/tauri.macos.conf.json` (exact contents in spec §3)
- Create: `.github/scripts/apple-signing-env.sh` (mode 755; `git add` records the bit)
- Modify: `.github/workflows/ci.yml` (add `package-macos` after `package-windows`)
- Modify: `.github/workflows/release.yml` (add `build-macos` after `build-windows`; extend `publish`)
- Modify: `README.md` (intro, `## Install`, `## Development`, `## Releasing`, `## Status`; text in spec §7)
- Modify: `docs/adr/0006-per-platform-bundles-and-release.md` (R4 renamed, R13 and R14 added, Consequences updated; content in spec §7)

**Interfaces:**

- Consumes: Task 1's assertions (values in Global Constraints and spec §3–§4).
- Produces: job ids `package-macos` and `build-macos` that Task 3 watches, and the artifact prefix `git-real-macos-` Task 3 downloads.

- [ ] **Step 1: Write the overlay**

`src-tauri/tauri.macos.conf.json` exactly as spec §3.

- [ ] **Step 2: Write `.github/scripts/apple-signing-env.sh`**

`#!/usr/bin/env bash`, `set -euo pipefail`. Behaviour (spec R5): read the six `APPLE_*` names and `GITHUB_ENV` with `${VAR:-}`; a variable is "set" when non-empty. Validate before writing anything, exiting 1 with a one-line message on stderr that names the variable at fault: `GITHUB_ENV` empty; `APPLE_CERTIFICATE` set without `APPLE_CERTIFICATE_PASSWORD` (name the password) or the reverse (name the certificate); `APPLE_SIGNING_IDENTITY` set without `APPLE_CERTIFICATE`; any of `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` set without all three (name the first missing one) or without `APPLE_CERTIFICATE`. Then append each set variable to `$GITHUB_ENV` as `NAME<<EOF_APPLE_SIGNING`, the value, `EOF_APPLE_SIGNING`, each on its own line, and print exactly one of the three notice lines from Global Constraints to stdout. The validation order is the builder's, provided each test case names the variable its assertion expects. `chmod +x` the file.

- [ ] **Step 3: Add `package-macos` to `ci.yml`**

After `package-windows`, mirroring its layout with the macOS values from Global Constraints and spec §4.2: checkout, Node 24 with npm cache, Rust stable with the two targets, `Swatinem/rust-cache@v2` with `workspaces: src-tauri`, `npm ci`, the build command, the upload. No `shell:` overrides, no gate, no secrets.

- [ ] **Step 4: Add `build-macos` to `release.yml` and extend `publish`**

`build-macos` as spec §4.3: the `package-macos` steps through `npm ci`, then the `Prepare Apple signing` step with the six-line `env:` block and `run: .github/scripts/apple-signing-env.sh`, then the build step with no `env:`, then the `release-macos` upload. `publish`: `needs` gains `build-macos`; `files` gains `release-assets/**/*.dmg` as the sixth line.

- [ ] **Step 5: Update the README and ADR 0006**

README per spec §7: intro and `## Status` (no follow-on platform), the macOS install bullet (universal DMG, drag to Applications, Privacy & Security "Open Anyway" on macOS 15 and later, Control-click Open earlier, the `xattr -d com.apple.quarantine` alternative, Xcode Command Line Tools for `git`), the `## Releasing` paragraph (three platforms, six files, signs and notarizes when the `APPLE_*` secrets are present, unsigned otherwise), the `## Development` "Building on macOS" paragraph. ADR 0006 per spec §7: R4 heading becomes `R4 — Windows signing stays out of the code` with its body unchanged; new R13 (macOS signing wired, dormant: the owner's ruling, why it differs from R4, the gate rules, the `var_os` fact, the six names with the identity optional, the `.app` notarized and stapled and the DMG code-signed only) and R14 (one universal DMG, the `universal-apple-darwin` output path); Consequences updated as spec §7 says. Keep the ADR's `Status: Accepted` and add an "Amended 2026-10-28 by GR-23" line under `Date`.

- [ ] **Step 6: Run the suite and lint**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, including every test in `release.test.ts` and `apple-signing-env.test.ts`. Also run `cd src-tauri && cargo build` to confirm the overlay file does not disturb the Linux build (Tauri ignores other platforms' overlays).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.macos.conf.json .github/scripts/apple-signing-env.sh .github/workflows/ci.yml .github/workflows/release.yml README.md docs/adr/0006-per-platform-bundles-and-release.md
git commit -m "feat(GR-23): universal macOS DMG, package and build jobs, dormant Apple signing gate, ADR 0006 R13-R14"
```

Confirm with `git ls-files -s .github/scripts/apple-signing-env.sh` that the mode is `100755`.

---

### Task 3: Prove the macOS build on CI and record the probe

**Files:**

- Modify: `docs/superpowers/specs/2026-10-28-gr23-macos-build-design.md` (§5.1 Probe results)
- Possibly modify, under spec R8 only: files in `src-tauri/src/`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md` (file name)

**Interfaces:**

- Consumes: the branch with Tasks 1–2 committed; job id `package-macos`; artifact prefix `git-real-macos-`.
- Produces: a green `Package (macOS)` run on the branch, the real DMG file name and size in spec §5.1.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feature/gr-23-macos-build`
Expected: accepted. If GitHub rejects with a workflow-scope error, stop and report.

- [ ] **Step 2: Watch the CI run**

Run: `gh run list --branch feature/gr-23-macos-build --workflow=ci.yml --limit 1` for the run id, then `gh run watch <id> --exit-status` (allow 40 minutes; a universal build compiles twice). On completion: `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'`.
Expected: `Package (macOS): success`, with `Package (Linux)`, `Package (Windows)`, `Core crate (Windows)` and `build-and-test` also `success`. `Benchmarks (large repositories)` has been failing on `main` since 535677a; record its conclusion, do not act on it.

- [ ] **Step 3: On a macOS failure, apply spec R8 and repeat**

Run: `gh run view <id> --log-failed | tail -150`. Classify:

- A `bundle_dmg.sh` / Finder / AppleScript error in the DMG step → re-run the job once (`gh run rerun <id> --failed`) before changing anything; if it fails the same way twice, stop and report with the log excerpt.
- A gate, an import, or a one-line platform branch in `src-tauri/src/` fixes it → make the change with a one-line comment naming GR-23, run `cd src-tauri && cargo build` locally, commit as `fix(GR-23): <what failed on macOS and the gate>`, push, return to Step 2.
- The build step needs an adjustment (a missing target, a `timeout-minutes`) → edit `package-macos` and `build-macos` identically, run `npx vitest run src/test/release.test.ts`, commit, push, return to Step 2.
- Anything in `git-real-core`, or anything larger → stop and report to the orchestrator with the log excerpt. Do not work around it.
  Record every round (run id, failure in one line, fix in one line) for §5.1.

- [ ] **Step 4: Download the green artifact and check the DMG**

Run, in the scratchpad directory:

```sh
gh run download <id> -n git-real-macos-$(git rev-parse HEAD) -D gr23-macos
find gr23-macos -type f -printf '%s %p\n'
```

Expected: exactly one `.dmg`, larger than 5 242 880 bytes, at the root of the download directory (no `dmg/` folder; if a folder is present, note it in §5.1, the `**` glob covers both). From the job log (`gh run view <id> --log | grep -E "Compiling git-real |lipo|Finished|Bundling"`), confirm both targets compiled and the bundler wrote the DMG under `universal-apple-darwin/`.

- [ ] **Step 5: Fill §5.1 and correct the README if the name differs**

In the spec's `### 5.1 Probe results`, replace the placeholder line with: the number of CI rounds, one bullet per round from Step 3 (or "one round, green on the first push"), the green run id, the `Package (macOS)` duration from `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.startedAt) \(.completedAt)"'`, the artifact layout, and the DMG file name with its byte size. If the name differs from `Git Real_0.1.0_universal.dmg`, update the README's macOS file name (keeping the `Git.Real` dot spelling) and the spec §3 table. If the macOS job took more than 30 minutes, add `timeout-minutes: 45` to both macOS jobs.

- [ ] **Step 6: Run the suite and commit**

Run: `npm run lint && npm test`
Expected: clean.

```bash
git add docs/superpowers/specs/2026-10-28-gr23-macos-build-design.md
# plus README.md and the workflows only if Step 5 changed them
git commit -m "docs(GR-23): macOS probe results"
git push
```

- [ ] **Step 7: Confirm the final push is green**

Run: `gh run list --branch feature/gr-23-macos-build --workflow=ci.yml --limit 1` then `gh run watch <id> --exit-status`.
Expected: `Package (macOS)`, `Package (Linux)` and `Package (Windows)` all `success` on the final commit.
