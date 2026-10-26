# Git Real

Git Real is a free, lightweight, cross-platform desktop Git client. It is built with
Tauri 2 and Rust on the backend and React with TypeScript on the front end, and it aims
to cover the everyday Git workflows of a developer in one fast, native-feeling window.

Linux (Wayland, with the COSMIC desktop as the primary target) is the first-class
platform. macOS and Windows are follow-on targets.

## Features

- **Repositories**: open, clone, and initialize repositories; recent-repository list.
- **Working tree**: stage, unstage, and discard changes by file, hunk, or line, with a
  syntax-highlighted diff viewer.
- **Commits**: commit with subject and body, amend, and link hosting issues from the
  message editor.
- **Branches**: create, check out, rename, and delete branches; track upstreams.
- **History**: a commit graph with lanes, merges, and ref labels; commit detail with
  per-file diffs; file history and blame.
- **Merge and rebase**: merge, rebase, and interactive rebase with an inline conflict
  editor and drag-to-merge.
- **Stashes and tags**: create, apply, pop, and drop stashes; create and delete tags.
- **Remotes**: fetch, pull, and push with SSH and HTTPS credential prompts; manage
  remotes.
- **Hosting integration** (GitHub, GitLab, Bitbucket): connect accounts with personal
  access tokens stored in the OS keychain, list and check out pull requests, create a
  pull request from the current branch, browse open issues, and insert `#n` issue
  references while committing.

## Technology

| Layer     | Choice                                                                   |
| --------- | ------------------------------------------------------------------------ |
| Shell     | Tauri 2 (system WebView)                                                 |
| Backend   | Rust; `git2` (libgit2) for local reads, the system `git` CLI for network |
| Front end | React 19, TypeScript, TanStack Query, Zustand, CSS Modules               |
| Editor    | CodeMirror 6 for diffs and conflict editing                              |
| Secrets   | OS keychain via `keyring`                                                |
| Tests     | `cargo test` for Rust, Vitest for the front end                          |

The Git domain logic lives in a pure Rust crate, `git-real-core`, that has no Tauri
dependency, so it unit tests with a plain `cargo test`. A thin Tauri layer exposes it
to the front end over typed IPC commands.

## Architecture in brief

- **Hybrid Git backend.** `git2` handles status, log, diff, refs, and blame. Anything
  that touches the network, credentials, or signing shells out to the system `git`,
  so SSH agents, credential helpers, and GPG or SSH signing work the way they already
  do on your machine.
- **Single IPC seam.** Only `src/lib/ipc` talks to Tauri. Features import typed
  wrappers from there, which is also the one mock point for front-end tests.
- **Off the UI thread.** Blocking Git work runs in Tauri's async runtime so the
  interface never stalls.
- **Decisions are recorded.** Architecture decision records live in
  [docs/adr](docs/adr). Feature designs and implementation plans live under
  [docs/superpowers](docs/superpowers).

## Install

Pre-built Linux packages are published on each release. Download the one for your
distribution from the [GitHub Releases](https://github.com/harmonizationllc/git-real/releases)
page (`<version>` is the release, for example `0.1.0`). The file names carry the product
name with a space in it — `Git Real_<version>_amd64.deb` — so quote the path:

- **Debian, Ubuntu, Pop!\_OS** — the `.deb`:

  ```sh
  sudo apt install "./Git Real_<version>_amd64.deb"
  ```

- **Fedora, RHEL, openSUSE** — the `.rpm`:

  ```sh
  sudo dnf install "./Git Real-<version>-1.x86_64.rpm"
  ```

- **Any distribution** — the AppImage, which installs nothing:

  ```sh
  chmod +x "Git Real_<version>_amd64.AppImage"
  "./Git Real_<version>_amd64.AppImage"
  ```

The `.deb` recommends `git`, and you should have it on any install: every network
operation (fetch, pull, push, clone over the network) and all commit signing shell out
to the system `git` CLI, so Git Real needs it on your `PATH`.

## Wayland and X11

Git Real runs under both Wayland and X11. On COSMIC the window uses the compositor's
server-side decorations, so it looks and resizes like any other COSMIC window. Two
environment switches cover the stacks that need them:

- `GDK_BACKEND=x11 git-real` forces the app to run under X11 (XWayland) instead of
  Wayland.
- `WEBKIT_DISABLE_DMABUF_RENDERER=1 git-real` works around a blank window seen on some
  NVIDIA and Wayland driver combinations.

## Development

Prerequisites:

- **Rust** (stable, via [rustup](https://rustup.rs/))
- **Node.js 24** and npm
- On Debian, Ubuntu, or Pop!\_OS, the Tauri Linux system libraries:

  ```sh
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libxdo-dev \
    pkg-config \
    file \
    patchelf
  ```

Getting started:

```sh
npm install        # install front-end dependencies
npm run tauri dev  # run the desktop app in development
```

Common commands:

| Command                                   | What it does                                  |
| ----------------------------------------- | --------------------------------------------- |
| `npm run tauri dev`                       | Run the app in development                    |
| `npm test`                                | Front-end unit tests (Vitest)                 |
| `npm run test:coverage`                   | Front-end tests with the 100 % coverage gate  |
| `npm run lint`                            | ESLint and Prettier checks                    |
| `npm run typecheck`                       | `tsc --noEmit`                                |
| `npm run build`                           | Type-check and build the front-end bundle     |
| `cargo test --workspace`                  | All Rust tests (run from `src-tauri`)         |
| `cargo test -p git-real-core`             | Fast pure-domain tests (run from `src-tauri`) |
| `cargo clippy --workspace -- -D warnings` | Rust lints (run from `src-tauri`)             |

Rust tests need `git` on `PATH`; set `GIT_REAL_SKIP_GIT_TESTS=1` to skip the tests that
drive the git CLI.

### How the project is built

Every feature starts as a design document, then an implementation plan, then
test-first development: tests are written before the code they exercise, coverage is
kept at 100 % on the front end, and each change passes a code review and an
architecture review before it is merged. The design and plan documents are checked in
under `docs/superpowers` so the reasoning behind each feature travels with the code.

## Releasing

A release is cut from a tag. The three app version strings must agree, and the release
workflow refuses a tag that does not match.

1. Set the same `X.Y.Z` version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`.
2. Run `npm test` — a contract test checks that the three versions agree.
3. Commit the version bump.
4. Tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

The `Release` workflow then builds the `.deb`, `.rpm`, and AppImage and publishes a
GitHub release carrying them, with generated release notes. A tag whose version differs
from `tauri.conf.json` fails before anything is built. A pre-release tag contains a
hyphen (for example `vX.Y.Z-beta.1`) and is marked as a pre-release; the in-app update
check reads the latest non-prerelease release, so pre-releases do not prompt users to
update.

## Project layout

```
src/                 React front end (features, components, lib/ipc seam, stores)
src-tauri/           Tauri app crate: commands, events, keychain, registration
src-tauri/crates/
  git-real-core/     Pure Rust Git domain: git2 reads, git CLI network ops, hosting APIs
docs/adr/            Architecture decision records
docs/superpowers/    Feature design specs and implementation plans
```

## Status

Git Real is at version 0.1.0 and under active development. The features above are
implemented and tested, and Linux packages are published on each release; performance
validation on very large repositories is still ahead.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).
