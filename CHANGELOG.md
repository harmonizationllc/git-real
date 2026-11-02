# Changelog

Release notes for Git Real, newest first. Each `## X.Y.Z` section is the body of the
GitHub release with the same tag; the Release workflow refuses a tag whose section is
missing or empty.

## 0.1.0

The first release of Git Real, a free, lightweight desktop Git client for Linux,
Windows and macOS.

- **Repositories**: open, clone and initialize repositories, with a recent list.
- **Working tree**: stage, unstage and discard changes by file, hunk or line, with a
  syntax-highlighted diff viewer.
- **Commits**: subject and body, amend, and issue links from the message editor.
- **Branches**: create, check out, rename and delete branches; track upstreams.
- **History**: a commit graph with lanes, merges and ref labels; commit detail with
  per-file diffs; file history and blame.
- **Merge and rebase**: merge, rebase and interactive rebase with an inline conflict
  editor and drag-to-merge.
- **Stashes and tags**: create, apply, pop and drop stashes; create and delete tags.
- **Remotes**: fetch, pull and push over SSH and HTTPS with credential prompts; manage
  remotes.
- **Hosting**: GitHub, GitLab, Bitbucket and Azure DevOps accounts with tokens in the
  OS keychain; list, check out and create pull requests; browse issues and work items;
  insert issue references while committing.

Downloads: `.deb`, `.rpm` and AppImage for Linux, an NSIS setup `.exe` and an MSI for
Windows, and a universal `.dmg` for macOS. The installers are not yet code-signed, so
Windows SmartScreen and macOS Gatekeeper ask before the first launch; the README's
Install section explains each step. Linux (Wayland, COSMIC) is the first-class platform.
