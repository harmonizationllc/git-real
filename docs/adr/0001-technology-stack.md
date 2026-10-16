# ADR 0001 — Technology stack and Git backend

- Status: Accepted
- Date: 2026-10-14
- Epic: GR-1 / Story: GR-2 "Decide technology stack and Git backend"

## Context

Git Real is a free, self-owned, cross-platform desktop Git client intended to replace the owner's current commercial Git client.
The owner's stated priorities, in order: free to use and own, runs on multiple platforms,
lightweight, and loads large repositories fast. A WebView-based UI is acceptable provided
native behaviors such as right-click context menus work as they do in Electron. Primary
target is Linux (Pop!_OS with the COSMIC desktop on Wayland); macOS and Windows follow.

The sibling projects in this workspace are JavaScript (Node ESM and Expo/React Native), so
TypeScript familiarity is high and Rust familiarity is low. No Rust toolchain was installed
before this decision.

## Options considered

| Option | UI | Native right-click | Install size | Idle RAM | Git backend | License |
|---|---|---|---|---|---|---|
| Tauri 2 (Rust + TypeScript UI) | System WebView | Yes, Tauri menu API | ~10 MB | ~50 MB | git2-rs (libgit2) + git CLI | MIT / Apache-2.0 |
| Electron (Node + TypeScript) | Bundled Chromium | Yes, Menu.popup | ~150 MB | ~200 MB | git CLI or unmaintained nodegit | MIT |
| Flutter desktop (Dart) | GPU-rendered widgets | In-app only | ~25 MB | ~80 MB | git CLI or libgit2 FFI | BSD-3 |
| Rust + iced / libcosmic | Native GPU-rendered | In-app only | ~8 MB | ~40 MB | git2-rs | MIT / MPL-2.0 |
| Qt 6 (C++ or PySide6) | Native widgets | Yes, QMenu | ~40 MB | ~70 MB | libgit2 | LGPL-3 or commercial |
| .NET + Avalonia | Native-drawn widgets | Yes | ~70 MB | ~100 MB | LibGit2Sharp | MIT |

Also considered and set aside: Wails (Go, smaller ecosystem than Tauri), Neutralino (no
native menus), Slint (GPL or attribution license), Electron.NET (dormant), MAUI (no Linux).

## Decision

**Tauri 2 with a Rust core and a React + TypeScript UI.**

- Tauri is the only option that satisfies lightweight, fast loading, multi-platform, and
  native right-click menus at the same time, with a permissive license and no runtime fees.
- The Git-heavy code is the part where language speed matters most. git2-rs is the best
  maintained libgit2 binding of the candidates (it is used by Cargo itself). The Node
  binding is unmaintained and .NET carries a 60 to 80 MB runtime.
- The UI, which is most of the code, stays in TypeScript. React was chosen over Svelte or
  Vue because the owner already uses React in an Expo project.

**Git backend is hybrid.**

- **Read operations** (refs, status, log and graph walk, diffs, blame) use git2-rs for
  speed and to avoid spawning a process per query.
- **Network, credentials, and signing** (fetch, pull, push, credential helpers, SSH agent,
  GPG/SSH commit signing) shell out to the system `git` CLI. libgit2 handles these poorly
  and the CLI honors the user's existing Git configuration unchanged.

## Consequences

- Rust must be learned for the core, but the Rust surface is bounded to the Git layer and
  Tauri command adapters. Rust 1.99 and the Tauri Linux build dependencies (webkit2gtk 4.1,
  gtk3, ayatana-appindicator, rsvg, openssl, xdo) are now installed on the primary machine.
- Linux renders in WebKitGTK, which trails Chromium on some CSS features. Test the UI in
  the Tauri window, not only in a browser.
- Rust compile times are longer than a Node restart; UI changes hot-reload without a
  Rust rebuild.
- A `git` executable must be on the user's PATH for network operations. The app should
  detect its absence and say so.
- Platform signing is the only recurring cost and is deferred: Apple Developer Program
  (99 USD/year) for notarized macOS builds, and a Windows code-signing certificate or Azure
  Trusted Signing (about 10 USD/month) to avoid SmartScreen warnings. Linux needs none.

See ADR 0002 for the resulting project structure.
