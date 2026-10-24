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
    pkg-config
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
implemented and tested; packaging for distribution and performance validation on very
large repositories are still ahead.

## License

MIT. See [LICENSE](LICENSE).
