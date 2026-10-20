# Git Real

Git Real is a lightweight, cross-platform desktop Git client built with Tauri 2, Rust,
and React. The Git domain logic lives in a pure Rust crate (`git-real-core`) that knows
nothing about the UI, while a thin Tauri layer exposes it to a React/TypeScript
front end.

## Prerequisites

- **Rust** (stable, via [rustup](https://rustup.rs/))
- **Node.js 24** and npm
- On Debian / Ubuntu / Pop!\_OS, the Tauri Linux system libraries:

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

## Getting started

```sh
npm install        # install front-end dependencies
npm run tauri dev  # run the desktop app in development
```

## Common commands

| Command                  | What it does                              |
| ------------------------ | ----------------------------------------- |
| `npm run tauri dev`      | Run the app in development                |
| `npm test`               | Run the front-end unit tests (Vitest)     |
| `npm run lint`           | ESLint + Prettier checks                  |
| `npm run build`          | Type-check and build the front-end bundle |
| `cargo test --workspace` | Run the Rust tests (from `src-tauri`)     |

Rust tests need `git` on PATH; set `GIT_REAL_SKIP_GIT_TESTS=1` to skip the git CLI tests.

## Architecture

Design decisions are recorded as ADRs in [docs/adr](docs/adr). The project uses a
hybrid Git backend: `git2` (libgit2) for local reads, and the system `git` CLI for
network, credential, and signing operations.
