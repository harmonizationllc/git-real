# ADR 0005 — Settings owned by Rust

- Status: Accepted
- Date: 2026-10-26
- Epic: GR-1 / Story: GR-29 "Revisit decisions made during unattended AFK runs", item 1

## Context

Git Real's preferences were spread over five places. Four zustand `persist` stores kept
thirteen values in the browser's `localStorage` (appearance, diff, layout and update
preferences), and a flat version-1 `settings.json` written by Rust held the five
backend settings from GR-14. GR-14 ruling R3 chose that split. The owner reversed it
under GR-29: every setting should live in one plain file that a person can open, read,
back up and copy to another machine. The app had not shipped, so no user data had to be
carried over.

## Decision

- **One file.** `settings.json` in the Tauri app config directory holds every setting
  the user can change. It is grouped (`git`, `clone`, `tools`, `appearance`, `diff`,
  `layout`, `updates`, `window`) and versioned, and this change makes it version 2.
- **Rust owns it.** The `SettingsStore` in the backend is the only reader and writer.
  The front end gets settings through typed IPC wrappers and never touches the file.
- **Lenient per-field load.** A missing, unreadable, corrupt or other-version file
  yields defaults. A value that fails validation is replaced by its default for that
  field only, and the rest of the file is kept. On load only shape is checked; paths
  are verified when the user sets them, never at load.
- **The main window is built in Rust.** Its definition moves out of `tauri.conf.json`
  into `src-tauri/src/main_window.rs`, created in `setup` after the store loads. The
  builder applies the stored size and maximized state, and attaches an initialization
  script that injects the settings before any page script runs, so the first paint
  already uses the right theme, layout and diff settings.
  It also builds the window hidden, sets the window and webview background from the
  stored theme (desktop scheme via the settings portal for "system") and pre-applies
  data-theme in the init script before showing it, so the first frame is already in the
  right theme (GR-19).
- **No `localStorage` for preferences.** The four persist stores are deleted.
- **`lastCheckedAt` stays in the browser.** The time of the last update check is
  bookkeeping, not a preference, and writing it to the file would rewrite the file
  daily. It lives alone in the `updateState` store.
- **A missing Git executable falls back to PATH.** If the configured executable does
  not exist on this machine, Git Real uses the Git on PATH and shows a notice.

## Consequences

- `settings.json` is a user-visible contract from the first tagged release. Every later
  shape change owes a migration, and the version number is how that migration is
  detected.
- Hand edits and a file copied from another machine apply at the next launch. There is
  no live reload.
- Window size and maximized state are saved when the window closes, and only when they
  differ from what the file holds. A crash loses the last resize. Position is not
  stored.
- There is no migration of the version-1 file or of the old browser keys, because the
  app had not shipped. `lastCheckedAt` starts over under its new key.
- The main window no longer appears in `tauri.conf.json`. Tests that read the window
  definition from there read `main_window.rs` instead.
- A hand-edited out-of-range value stays in the file as written, with the clamped value
  in effect, until the user changes some setting and the file is rewritten.

## Alternatives considered

- **Keep the split store with a neutral loading screen.** Rust would own the backend
  settings and the browser would keep the rest. Rejected because it leaves two places
  to back up and copy, which is what the owner objected to. It also needs a loading
  screen to avoid a flash of the wrong theme.
- **Live reload of hand edits.** Rejected because next-launch application is enough,
  and a file watcher adds races with the app's own writes.
- **Storing window position.** Rejected because Wayland does not expose window
  position to applications, and Wayland is the first-class target.
