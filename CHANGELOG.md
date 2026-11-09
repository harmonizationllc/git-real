# Changelog

Release notes for Git Real, newest first. Each `## X.Y.Z` section is the body of the GitHub release with the same tag; the Release workflow refuses a tag whose section is missing or empty. Keep each paragraph and bullet on one line: GitHub renders a newline inside a release body as a line break.

## 0.3.0

- **Change ruler**: a strip beside the diff's scrollbar marks every change block (green added, red removed, amber modified) across the whole file; click a mark to jump to it.

## 0.2.0

Layout and workflow improvements across the left column, the Changes panel and the diff pane, plus Windows and corporate-network fixes.

- **Whole-file diff**: the diff pane shows the entire file with changes in place, with previous and next change buttons (F7 / Shift+F7) (GR-51).
- **Right-click staging**: stage, unstage and revert the line under the pointer or the highlighted text, down to the word (GR-52).
- **Changes panel**: Unstaged sits above Staged and both panes are always visible, separated by a draggable divider whose position is remembered (GR-50).
- **Left column**: branches are split into Local and Remote sections, one filter box covers branches, stashes, worktrees, pull requests and issues, and section headers carry an accent-tinted band (GR-57, GR-58).
- **Branch folders**: Local and Remote branches are grouped into collapsible folders by their slash path, every folder open by default (GR-54).
- **Set upstream**: a Set upstream… item in the branch context menu picks the remote branch a local branch tracks, or clears a gone upstream (GR-45).
- **Repository tabs**: drag a tab to reorder the open repositories (GR-43).
- **Tracking badge**: the ahead/behind badge shows only non-zero counts and an in-sync branch shows a clean row (GR-44).
- **Keyboard shortcuts dialog**: the Keyboard shortcuts dialog (Ctrl+/ or ⌘/) is now where shortcuts are changed, and the Settings dialog no longer lists them (GR-56).
- **Removed**: hunk headers and line-number selection in the diff pane.
- **Fixed**: right-click no longer opens the browser's own menu, whose Reload item closed every repository (GR-53).
- **Fixed**: Close on commit details, stash details and the error panel also closes the diff that was opened from them (GR-47).
- **Fixed**: hosting accounts (GitHub, GitLab, Bitbucket, Azure DevOps) verify TLS against the operating system's certificate store, so they work behind TLS-inspecting corporate proxies.
- **Fixed**: a very long branch list no longer scrolls the whole window; section header labels and buttons are vertically centred.
- **Fixed (Windows)**: git and ssh run without flashing a console window, ssh never waits on a hidden prompt, and whole-file diffs no longer fail on xdiff's hunk-merge distance (GR-48, GR-55).

## 0.1.0

The first release of Git Real, a free, lightweight desktop Git client for Linux, Windows and macOS.

- **Repositories**: open, clone and initialize repositories, with a recent list.
- **Working tree**: stage, unstage and discard changes by file, hunk or line, with a syntax-highlighted diff viewer.
- **Commits**: subject and body, amend, and issue links from the message editor.
- **Branches**: create, check out, rename and delete branches; track upstreams.
- **History**: a commit graph with lanes, merges and ref labels; commit detail with per-file diffs; file history and blame.
- **Merge and rebase**: merge, rebase and interactive rebase with an inline conflict editor and drag-to-merge.
- **Stashes and tags**: create, apply, pop and drop stashes; create and delete tags.
- **Remotes**: fetch, pull and push over SSH and HTTPS with credential prompts; manage remotes.
- **Hosting**: GitHub, GitLab, Bitbucket and Azure DevOps accounts with tokens in the OS keychain; list, check out and create pull requests; browse issues and work items; insert issue references while committing.

Downloads: `.deb`, `.rpm` and AppImage for Linux, an NSIS setup `.exe` and an MSI for Windows, and a universal `.dmg` for macOS. The installers are not yet signed with a Developer ID or Authenticode certificate, so Windows SmartScreen and macOS Gatekeeper stop the first launch until you allow it; the [README's Install section](https://github.com/harmonizationllc/git-real#install) explains each step. Linux (Wayland, COSMIC) is the first-class platform.
