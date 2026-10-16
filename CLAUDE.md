# Git Real

Git Real is a lightweight, cross-platform desktop Git client: Tauri 2 + Rust on the
backend, React + TypeScript on the front end. Architecture decisions live in
[docs/adr](docs/adr); read the latest before making structural changes.

## Git backend rule (hybrid)

- Use **git2** (libgit2) for local reads: status, log, diff, refs, blame.
- Shell out to the system **git CLI** for anything touching the network,
  credentials, or signing: fetch, pull, push, clone-over-network, GPG/SSH signing.
- `git2` is built with `default-features = false`; do not re-enable its network
  features to "simplify" a network operation.

## Commands

```sh
npm run tauri dev              # run the app in development
npm test                       # front-end unit tests (Vitest)
npm run lint                   # ESLint + Prettier
npm run typecheck              # tsc --noEmit
npm run build                  # type-check + build front-end bundle
cargo test -p git-real-core        # fast pure-domain tests (from src-tauri)
cargo test --workspace         # all Rust tests (from src-tauri)
cargo clippy --workspace -- -D warnings   # (from src-tauri)
```

## TDD policy

- Tests come first, always, and are written by the agent team's test role, not
  inline. The developer role writes the minimum code to make failing tests pass
  and never edits test files.
- The pure domain lives in `git-real-core`, which has no Tauri dependency so it unit
  tests with a plain `cargo test` and keeps the red/green cycle fast.

## IPC seam rule

- The **only** place allowed to import `@tauri-apps/api/core` (i.e. call `invoke`)
  is `src/lib/ipc`. Features import typed wrappers from there, never `invoke`
  directly. That single seam is also the one mock point for front-end tests.

## Concurrency constraint

- `git2::Repository` is `Send` but **not** `Sync`: it can move to a thread or sit
  behind a mutex, but cannot be shared by reference across threads.
- Run blocking git2 work inside `tauri::async_runtime::spawn_blocking` so it never
  blocks the IPC/UI thread. Do **not** add a direct `tokio` dependency; use Tauri's
  `async_runtime`.

## Target platform

Linux (Wayland, with COSMIC as the primary desktop) is the first-class target.
Keep platform-specific assumptions out of `git-real-core`.
