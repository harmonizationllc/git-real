# GR-24 Windows Build and Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tests first, by the test role; the developer writes the minimum change that makes them pass and never edits test files. Every dispatch: `git add <explicit paths>` only; never `git reset`, `git commit --amend`, `git stash`, `git add -A`, `git add -u`, or anything that rewrites history. Only Task 3 pushes, and only its own branch. Run `git log -3` before committing.

**Goal:** A `v*` tag publishes one GitHub release carrying the Linux deb/rpm/AppImage and the Windows NSIS and MSI installers, CI builds the Windows installers on every push, and the Tauri bundle config is split per platform so macOS can follow with one file and one job.

**Architecture:** Everything is declarative: two Tauri overlay files replace the Linux-specific keys of `tauri.conf.json`, the release workflow becomes check → two parallel builds → one publish, CI gains a Windows package job, and the Vitest contract test in `src/test/release.test.ts` pins all of it. No Rust or TypeScript source changes are expected; the only unknown is whether the app crate compiles on Windows, which Task 3 proves on CI.

**Tech Stack:** Tauri 2.12 CLI (`npm run tauri build`), GitHub Actions (`windows-latest`, `ubuntu-22.04`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `softprops/action-gh-release@v2`), Vitest with the `yaml` package.

**Spec:** `docs/superpowers/specs/2026-10-27-gr24-windows-build-design.md` (R1–R12 are decided; do not reopen them).

**Branch:** `feature/gr-24-windows-build` from `main` (4476849), in a worktree under `.claude/worktrees/gr-24-windows-build`.

## Global Constraints

- Commits carry the repo-local noreply author email (`git config user.email` already returns it in this clone; worktrees inherit it). Commit messages end with the attribution lines the session reminder gives.
- No Rust or TypeScript source edits unless Task 3 hits a Windows compile failure, and then only under spec R8: a gate, an import, or a one-line platform branch in `src-tauri/src/`, with a comment; never in `git-real-core`.
- No new npm or Cargo dependency. No Tauri plugin. No secret referenced in any workflow. No `signCommand`, `certificateThumbprint` or `timestampUrl` anywhere (R4).
- `npm run lint` (ESLint + Prettier, which also formats the JSON, YAML and Markdown files touched here), `npm run typecheck`, `npm test` clean before every commit that touches a file they cover.
- Exact values, copied from the spec and reused by every task:
  - Linux bundle list `deb,rpm,appimage`; Windows bundle list `nsis,msi`.
  - Bundle globs: `src-tauri/target/release/bundle/deb/*.deb`, `…/rpm/*.rpm`, `…/appimage/*.AppImage`, `…/nsis/*.exe`, `…/msi/*.msi`.
  - CI upload names `git-real-linux-${{ github.sha }}` and `git-real-windows-${{ github.sha }}`, `retention-days: 14`, `if-no-files-found: error`.
  - Release artifact names `release-linux` and `release-windows`, `retention-days: 1`, `if-no-files-found: error`; download with `pattern: release-*`, `merge-multiple: true`, `path: release-assets`; publish globs `release-assets/*.deb`, `release-assets/*.rpm`, `release-assets/*.AppImage`, `release-assets/*.exe`, `release-assets/*.msi`.
  - Version shape regex, literally in the guard script: `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$`.
  - Download file names in the README use `Git.Real_` (R12). Pre-release example in the README is `vX.Y.Z-1` (R10).
  - Every `run` step on a Windows runner sets `shell: bash` (R11).

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its pinning test added to the owning task below.

1. **A pre-release version in the three version files** (`0.2.0-1`): the contract test must accept it, or the release procedure in the README cannot be followed. Pinned in Task 1 (`versions › version is MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-N`).
2. **A `-beta.1` tag**: the guard must fail before any build starts so the MSI failure never happens. Pinned in Task 1 (`release workflow › check-version rejects non-numeric pre-release identifiers`, asserting the regex text is in the script and the step is in `check-version`).
3. **One build job fails**: `publish` must not run and no half release appears. Pinned in Task 1 (`publish needs both build jobs`; GitHub skips a job whose `needs` failed).
4. **PowerShell on the Windows runner** splitting `nsis,msi`: pinned in Task 1 (`every run step on windows-latest sets shell bash`).
5. **A user following the README download names**: the names must carry the dot GitHub inserts. Pinned in Task 1 (`README › install section spells download names Git.Real_`).

---

### Task 1: Contract tests for the per-platform config, workflows and README

**Files:**
- Modify: `src/test/release.test.ts`

**Interfaces:**
- Consumes: the existing helpers in the file (`readText`, `readJson`, `fileExists`, `extractAptPackages`, `aptStepScript`, `extractReadmeAptPackages`, `parseCargoVersion`), `yaml`'s `parse`.
- Produces: the red tests Tasks 2 and 3 turn green. Task 2 relies on the exact keys and values asserted here; they are the spec's values and are listed in Global Constraints.

- [ ] **Step 1: Restructure the file**

Keep the `desktop template`, `icon source` and `bench workflow` describe blocks and the helpers unchanged. Rewrite the `versions`, `bundle config`, `ci workflow`, `release workflow` and `apt packages` blocks and add `platform overlays` and `README` blocks, with these tests and assertions:

`versions`
- `package.json, tauri.conf.json and Cargo.toml agree`: unchanged.
- `version is MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-N`: `expect(String(pkgJson.version)).toMatch(/^\d+\.\d+\.\d+(-\d+)?$/)`.

`bundle config` (base file `src-tauri/tauri.conf.json`)
- `base config has no targets and no linux block`: `expect(bundle).not.toHaveProperty("targets")`; `expect(bundle).not.toHaveProperty("linux")`; `expect(bundle).not.toHaveProperty("windows")`.
- `category is DeveloperTool`, `descriptions, homepage and license are set`, `icon list includes icon.png and every file exists`, `icons are not the Tauri template files`, `window decorations are explicit in main_window.rs`: unchanged.

`platform overlays` (new)
- `exactly linux and windows overlays exist and each names its targets`: `readdirSync(resolve(ROOT, "src-tauri"))` filtered by `/^tauri\.([a-z]+)\.conf\.json$/`, platform names sorted `toEqual(["linux", "windows"])`; for each file, `Array.isArray(bundle.targets)` and `length > 0`.
- `linux overlay has the Linux targets and the deb/rpm block`: `targets` `toEqual(["deb", "rpm", "appimage"])`; `linux.deb.section === "vcs"`; `linux.deb.recommends` contains `"git"`; `linux.deb.desktopTemplate === "packaging/git-real.desktop"`; `linux.rpm.desktopTemplate === "packaging/git-real.desktop"`; `fileExists("src-tauri/packaging/git-real.desktop")`. (This replaces the old `deb recommends git and both desktop templates exist`.)
- `windows overlay has nsis and msi with a per-user NSIS install`: `targets` `toEqual(["nsis", "msi"])`; `windows.nsis.installMode === "currentUser"`.
- `windows overlay has no signing keys`: for each of `signCommand`, `certificateThumbprint`, `timestampUrl`: `expect(windows).not.toHaveProperty(key)`.
- `overlays carry the Tauri schema`: each overlay's `$schema === "https://schema.tauri.app/config/2"`.

`ci workflow`
- `has build-and-test, package-linux and package-windows jobs and no package job`: `toHaveProperty` for the three, `not.toHaveProperty("package")`.
- `package-linux bundles on ubuntu-22.04 and uploads the three globs`: the old `package` test body against `jobs["package-linux"]`, plus `expect(jobs["package-linux"].name).toBe("Package (Linux)")`.
- `package-windows bundles nsis and msi on windows-latest under bash and uploads both globs`: `runs-on === "windows-latest"`; `name === "Package (Windows)"`; the build step's `run` contains `npm run tauri build` and `--bundles nsis,msi`; every step with a `run` has `shell === "bash"`; no step's `run` contains `apt-get`; the `actions/upload-artifact@v4` step has `with.name` containing `git-real-windows-`, `with.path` containing both `…/nsis/*.exe` and `…/msi/*.msi`, `with["if-no-files-found"] === "error"`, `with["retention-days"] === 14`.
- `cancels in-progress runs per ref`: unchanged.

`release workflow` (all against `parse(readText(".github/workflows/release.yml"))`)
- `runs on v tags only`: `on.push.tags` `toEqual(["v*"])`, no `branches`. (Permissions move to the next test.)
- `has check-version, build-linux, build-windows and publish jobs`: `Object.keys(jobs).sort()` `toEqual(["build-linux", "build-windows", "check-version", "publish"])`.
- `check-version guards the tag and rejects non-numeric pre-release identifiers`: `jobs["check-version"].steps` contains a step named `Check the tag matches the app version` whose `run` contains `GITHUB_REF_NAME`, `tauri.conf.json` and the literal text `(-[0-9]+)?`.
- `both builds need check-version and publish needs both builds`: helper `needsOf(job) = [].concat(job.needs ?? [])`; `needsOf(build-linux)` `toEqual(["check-version"])`; same for `build-windows`; `needsOf(publish).sort()` `toEqual(["build-linux", "build-windows"])`.
- `build-linux builds the Linux bundles on ubuntu-22.04 and uploads release-linux`: `runs-on === "ubuntu-22.04"`; build step `run` contains `--bundles deb,rpm,appimage`; upload step `with.name === "release-linux"`, `with.path` contains the three Linux globs, `with["if-no-files-found"] === "error"`, `with["retention-days"] === 1`.
- `build-windows builds the Windows bundles on windows-latest under bash and uploads release-windows`: `runs-on === "windows-latest"`; build step `run` contains `--bundles nsis,msi`; every `run` step has `shell === "bash"`; upload step `with.name === "release-windows"`, `with.path` contains `…/nsis/*.exe` and `…/msi/*.msi`, `with["if-no-files-found"] === "error"`, `with["retention-days"] === 1`.
- `publish downloads both artifacts then releases all five globs once`: in `jobs.publish.steps`, the `actions/download-artifact@v4` step has `with.pattern === "release-*"`, `with["merge-multiple"] === true`, `with.path === "release-assets"`, and its index is lower than the `softprops/action-gh-release@v2` step's; the release step's `with` has `generate_release_notes === true`, `fail_on_unmatched_files === true`, `String(prerelease)` containing `contains(github.ref_name, '-')`, `String(name)` containing `Git Real`, and `String(files)` containing each of the five `release-assets/*.{deb,rpm,AppImage,exe,msi}` globs; across all jobs, exactly one step `uses` starts with `softprops/action-gh-release@v2`.
- `publish can write releases`: `(jobs.publish.permissions?.contents ?? conf.permissions?.contents) === "write"`.
- `has release-scoped concurrency to prevent duplicate releases`: unchanged.

`apt packages`
- `both workflows and the README list the same packages`: same body, reading `ciConf.jobs["package-linux"].steps` and `releaseConf.jobs["build-linux"].steps`.

`README` (new; helper `section(readme, heading)` returns the text from `\n## <heading>` to the next `\n## `)
- `intro no longer calls Windows a follow-on target`: `readme.slice(0, readme.indexOf("\n## "))` does not match `/Windows[^.\n]*follow-on/`.
- `install section documents the Windows installers and the SmartScreen prompt`: `section("Install")` contains `-setup.exe`, `.msi`, `SmartScreen`, `msiexec`.
- `install section spells download names Git.Real_`: `section("Install")` contains `Git.Real_` and does not contain `Git Real_`.
- `releasing section mentions Windows installers and a numeric pre-release example`: `section("Releasing")` contains `Windows`, contains `vX.Y.Z-1`, does not contain `-beta`.
- `development section has a Windows build paragraph`: `section("Development")` contains `Building on Windows`.
- `ADR 0006 exists and ADR 0003 points to it`: `fileExists("docs/adr/0006-per-platform-bundles-and-release.md")`; `readText("docs/adr/0003-release-pipeline-and-update-check.md")` contains `ADR 0006`.

- [ ] **Step 2: Run the file and confirm the new tests fail for the right reasons**

Run: `npx vitest run src/test/release.test.ts`
Expected: FAIL. The `desktop template`, `icon source`, `bench workflow`, `versions` and unchanged `bundle config` tests pass; every test in `platform overlays`, `README`, the new `ci workflow` and `release workflow` tests, `base config has no targets and no linux block`, and `apt packages` fail (missing files, missing job keys, old values). No failure may be a TypeError from the test code itself: guard every `jobs[...]` lookup with `?.` where the job may not exist yet so the assertion, not the access, fails.

- [ ] **Step 3: Lint and commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/test/release.test.ts
git commit -m "test(GR-24): pin per-platform Tauri overlays, Windows package jobs, the split release workflow and the README"
```

---

### Task 2: Per-platform config, workflows and documentation

**Files:**
- Modify: `src-tauri/tauri.conf.json` (remove `bundle.targets` and `bundle.linux`)
- Create: `src-tauri/tauri.linux.conf.json`, `src-tauri/tauri.windows.conf.json` (exact contents in spec §3)
- Modify: `.github/workflows/ci.yml` (rename `package` → `package-linux`; add `package-windows`)
- Modify: `.github/workflows/release.yml` (replace the single `release` job with `check-version`, `build-linux`, `build-windows`, `publish`)
- Modify: `README.md` (intro, `## Install`, `## Development`, `## Releasing`, `## Status`)
- Create: `docs/adr/0006-per-platform-bundles-and-release.md`
- Modify: `docs/adr/0003-release-pipeline-and-update-check.md` (one line under Consequences)

**Interfaces:**
- Consumes: Task 1's assertions (the values are in Global Constraints and spec §3–§4).
- Produces: the job ids `package-windows` and `build-windows` that Task 3 watches on CI, and the artifact name prefix `git-real-windows-` Task 3 downloads.

- [ ] **Step 1: Write the two overlay files and trim the base config**

Create `src-tauri/tauri.linux.conf.json` and `src-tauri/tauri.windows.conf.json` exactly as spec §3 shows (`$schema`, `bundle.targets`, and the `linux` block moved verbatim or the `windows.nsis.installMode` key). Delete `bundle.targets` and `bundle.linux` from `src-tauri/tauri.conf.json`; change nothing else in it.

- [ ] **Step 2: Run the config tests**

Run: `npx vitest run src/test/release.test.ts -t "bundle config|platform overlays"`
Expected: PASS.

- [ ] **Step 3: Prove the Linux overlay is read by building once**

Run (from the repo root, allow 10 minutes):
```sh
npm run tauri build -- --bundles deb
dpkg-deb -f "src-tauri/target/release/bundle/deb/Git Real_0.1.0_amd64.deb" Section Recommends
dpkg-deb -c "src-tauri/target/release/bundle/deb/Git Real_0.1.0_amd64.deb" | grep '\.desktop$'
```
Expected: `Section: vcs` and `Recommends: git` in the first output, one `.desktop` path in the second. Those two fields exist only because `bundle.linux` in the overlay was merged. If `Recommends` is missing, the overlay is not being read: stop and report; do not work around it by putting the block back in the base file.

- [ ] **Step 4: Edit `ci.yml`**

Rename job id `package` to `package-linux`, leaving its `name` and steps untouched. Add after it:

```yaml
  package-windows:
    name: Package (Windows)
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Set up Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Rust build
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install npm dependencies
        shell: bash
        run: npm ci

      - name: Build Windows bundles
        shell: bash
        run: npm run tauri build -- --bundles nsis,msi

      - name: Upload bundles
        uses: actions/upload-artifact@v4
        with:
          name: git-real-windows-${{ github.sha }}
          path: |
            src-tauri/target/release/bundle/nsis/*.exe
            src-tauri/target/release/bundle/msi/*.msi
          retention-days: 14
          if-no-files-found: error
```

- [ ] **Step 5: Rewrite the jobs in `release.yml`**

Keep `name`, `on`, `concurrency` as they are. Replace the `release` job with four jobs:

- `check-version` (`runs-on: ubuntu-latest`): checkout, then the existing step `Check the tag matches the app version` with `shell: bash` and this script (the first three lines are the existing ones):
  ```bash
  tag="${GITHUB_REF_NAME#v}"
  conf="$(node -p "require('./src-tauri/tauri.conf.json').version")"
  test "$tag" = "$conf" || { echo "tag v$tag != tauri.conf.json $conf"; exit 1; }
  [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]] || { echo "version $tag must be X.Y.Z or X.Y.Z-N; the Windows MSI accepts only a numeric pre-release identifier"; exit 1; }
  ```
- `build-linux` (`runs-on: ubuntu-22.04`, `needs: check-version`): the existing job's steps from checkout through `Build Linux bundles` unchanged, then an `actions/upload-artifact@v4` step with `name: release-linux`, the three Linux globs, `retention-days: 1`, `if-no-files-found: error`. No release step.
- `build-windows` (`runs-on: windows-latest`, `needs: check-version`): the `package-windows` steps from Step 4 with the upload renamed to `name: release-windows`, `retention-days: 1`.
- `publish` (`runs-on: ubuntu-latest`, `needs: [build-linux, build-windows]`, `permissions: contents: write`): one `actions/download-artifact@v4` step (`pattern: release-*`, `merge-multiple: true`, `path: release-assets`), then the existing `softprops/action-gh-release@v2` step with its `files:` replaced by the five `release-assets/*` globs. Drop the workflow-level `permissions` block, since only `publish` needs it (spec leaves this to the builder; this is the choice).

- [ ] **Step 6: Run the workflow tests**

Run: `npx vitest run src/test/release.test.ts -t "ci workflow|release workflow|apt packages|bench workflow"`
Expected: PASS.

- [ ] **Step 7: Update the README**

Edits, each one place:
- Intro line 8: `Linux (Wayland, with the COSMIC desktop as the primary target) is the first-class platform. Windows installers are built alongside the Linux packages; macOS is the follow-on target.`
- `## Install`: in the first paragraph, replace the sentence that starts `The file names carry the product name with a space in it` with: `The product name has a space in it, and GitHub replaces that space with a dot when it serves a release file, so a download is named `Git.Real_<version>_amd64.deb`; quote the path.` Change the three Linux file names in the commands to `Git.Real_…`. The string `Git Real_` must not remain anywhere in the section. Add a fourth bullet group **Windows** after the AppImage bullet: download `Git.Real_<version>_x64-setup.exe` and run it; because the installer is not yet code-signed, Windows SmartScreen shows "Windows protected your PC": choose **More info**, then **Run anyway**; the installer is per-user and needs no administrator rights; for managed deployment use the per-machine MSI, `msiexec /i "Git.Real_<version>_x64_en-US.msi"`; Windows 10 and 11 ship WebView2, and the installer downloads it on a machine that lacks it. Extend the final `git` paragraph with: `On Windows, install [Git for Windows](https://gitforwindows.org/) and let it add `git` to `PATH`.`
- `## Development`: after the apt block's bullet, add a bullet **Building on Windows**: Rust stable with the MSVC toolchain (rustup's default on Windows), Node.js 24, Visual Studio Build Tools 2022 with the "Desktop development with C++" workload, and WebView2 (preinstalled on Windows 10 and 11). `npm run tauri build -- --bundles nsis,msi` produces the installers under `src-tauri\target\release\bundle\`.
- `## Releasing`: the paragraph after the steps becomes: the `Release` workflow first checks the tag against the version, then builds the `.deb`, `.rpm` and AppImage on Linux and the NSIS `.exe` and `.msi` on Windows in parallel, then publishes one GitHub release carrying all five files with generated release notes. Replace the pre-release sentence: `A pre-release tag contains a hyphen followed by a plain integer (for example `vX.Y.Z-1`), because the Windows MSI format accepts only a numeric pre-release identifier; the workflow rejects any other shape. It is marked as a pre-release, and the in-app update check reads the latest non-prerelease release, so pre-releases do not prompt users to update.`
- `## Status`: `Linux packages are published on each release` → `Linux packages and Windows installers are published on each release`.

- [ ] **Step 8: Write ADR 0006 and the ADR 0003 pointer**

`docs/adr/0006-per-platform-bundles-and-release.md`, same header style as ADR 0005 (`Status: Accepted`, `Date: 2026-10-27`, `Epic: GR-1 / Story: GR-24 "Windows build, installer and code signing"`). Sections: Context (one paragraph: GR-15 shipped Linux only; GR-24 adds Windows and the owner wants macOS next), Decision (one bullet each for spec R2, R3, R4, R5, R7, R10, R12, in the spec's wording, plus one bullet stating the overlay merge semantics: JSON Merge Patch, arrays replaced whole, a platform without an overlay falls back to Tauri's `"all"`), Consequences (the signing recipe from spec §7 as a numbered list a follow-up story can be written from: `bundle.windows.signCommand` in `tauri.windows.conf.json` wrapping `trusted-signing-cli` with `%1`; secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, the Trusted Signing endpoint, account name and certificate profile name; an install step for `trusted-signing-cli` in `build-windows`; the note that SmartScreen reputation accrues to the publisher certificate, so one certificate serves every app the business ships; and the test assertion `windows overlay has no signing keys` that the signing story deletes).

In ADR 0003, under Consequences, change the Flatpak/macOS/Windows bullet to end with: `Windows builds landed in GR-24; see ADR 0006 for the per-platform configuration and the signing recipe.`

- [ ] **Step 9: Run the whole suite, lint, format**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all clean, every test in `src/test/release.test.ts` passing. If Prettier complains about the YAML, JSON or Markdown you wrote, run `npm run format` and re-run lint.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/tauri.linux.conf.json src-tauri/tauri.windows.conf.json .github/workflows/ci.yml .github/workflows/release.yml README.md docs/adr/0006-per-platform-bundles-and-release.md docs/adr/0003-release-pipeline-and-update-check.md
git commit -m "feat(GR-24): per-platform Tauri overlays, Windows package jobs, split release workflow, ADR 0006"
```

---

### Task 3: Prove the Windows build on CI and record the probe

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-gr24-windows-build-design.md` (§5.1 Probe results)
- Possibly modify, under spec R8 only: files in `src-tauri/src/`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md` (file names)

**Interfaces:**
- Consumes: the branch with Tasks 1–2 committed; job id `package-windows`; artifact prefix `git-real-windows-`.
- Produces: a green `Package (Windows)` run on the branch, the real Windows file names and sizes in spec §5.1.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feature/gr-24-windows-build`
Expected: the push is accepted (the token has the `workflow` scope; if GitHub rejects with a workflow-scope error, stop and report).

- [ ] **Step 2: Watch the CI run**

Run: `gh run list --branch feature/gr-24-windows-build --workflow=ci.yml --limit 1` to get the run id, then `gh run watch <id> --exit-status` (allow 25 minutes). On completion: `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'`.
Expected: `Package (Windows): success`, and `Package (Linux)`, `Core crate (Windows)` and `build-and-test` also `success`. `Benchmarks (large repositories)` was already failing on `main` at 4476849 and is not this story's concern; record its conclusion but do not act on it.

- [ ] **Step 3: On a Windows failure, apply spec R8 and repeat**

Run: `gh run view <id> --log-failed | tail -120`. Classify the failure:
- A gate, an import, or a one-line platform branch in `src-tauri/src/` fixes it → make the change with a one-line comment naming GR-24, run `cd src-tauri && cargo build` locally to confirm Linux still compiles, commit as `fix(GR-24): <what failed on Windows and the gate>`, push, return to Step 2.
- The build step itself needs an adjustment (a missing tool on the runner, the `core.autocrlf` step the spec left to the builder, a `timeout-minutes`) → edit the two workflows identically for `package-windows` and `build-windows`, run `npx vitest run src/test/release.test.ts`, commit, push, return to Step 2.
- Anything in `git-real-core`, or anything larger → stop and report to the orchestrator with the log excerpt. Do not work around it.
Record every round (run id, failure in one line, fix in one line) for §5.1.

- [ ] **Step 4: Download the green artifact and check the installers**

Run, in the scratchpad directory:
```sh
gh run download <id> -n git-real-windows-$(git rev-parse HEAD) -D gr24-windows
find gr24-windows -type f -printf '%s %p\n'
```
Expected: exactly one `.exe` and one `.msi`, each larger than 5 242 880 bytes. Record the file names and sizes.

- [ ] **Step 5: Fill §5.1 and correct the README if the names differ**

In the spec's `### 5.1 Probe results`, replace `Filled in by the builder.` with: the number of CI rounds, one bullet per round from Step 3 (or "one round, green on the first push"), the green run id, the job durations for `Package (Windows)` and `Package (Linux)` from `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.startedAt) \(.completedAt)"'`, and the two file names with byte sizes. If the `.exe` or `.msi` file name differs from `Git Real_0.1.0_x64-setup.exe` / `Git Real_0.1.0_x64_en-US.msi`, update the README's Windows file names (keeping the `Git.Real` dot spelling) and the spec §3 table. If the Windows job took more than 20 minutes, add `timeout-minutes: 30` to both Windows jobs.

- [ ] **Step 6: Run the suite and commit**

Run: `npm run lint && npm test`
Expected: clean.

```bash
git add docs/superpowers/specs/2026-10-27-gr24-windows-build-design.md
# plus README.md and the workflows only if Step 5 changed them
git commit -m "docs(GR-24): Windows probe results"
git push
```

- [ ] **Step 7: Confirm the final push is green**

Run: `gh run list --branch feature/gr-24-windows-build --workflow=ci.yml --limit 1` then `gh run watch <id> --exit-status`.
Expected: `Package (Windows)` and `Package (Linux)` both `success` on the final commit.
