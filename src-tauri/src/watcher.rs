//! Debounced recursive file watcher for an open repository's working tree and,
//! for a linked worktree, its common dir (where refs and the other worktrees' HEADs live).
//!
//! Knows nothing about Tauri or repo ids: the caller passes a plain `on_change` closure.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// Quiet period the app waits for before reporting a change.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);

type EventRx = Receiver<notify::Result<Event>>;

/// Watches a working tree and calls `on_change` once per burst of relevant events.
///
/// Dropping it stops the watch; no callback runs after `drop` returns.
pub struct RepoWatcher {
    /// `Option` so `Drop` can drop it (closing the channel) before joining the thread.
    watcher: Option<RecommendedWatcher>,
    thread: Option<JoinHandle<()>>,
}

impl RepoWatcher {
    /// Starts a recursive watch on `workdir`, and on `extra` when given, firing
    /// `on_change` after `debounce` of quiet. A missing root is an error.
    pub fn start(
        workdir: &Path,
        extra: Option<&Path>,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let workdir = workdir.canonicalize().map_err(notify::Error::io)?;
        let extra = extra
            .map(|p| p.canonicalize().map_err(notify::Error::io))
            .transpose()?;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx)?;
        watcher.watch(&workdir, RecursiveMode::Recursive)?;
        if let Some(extra) = &extra {
            watcher.watch(extra, RecursiveMode::Recursive)?;
        }
        let roots = Roots { workdir, extra };
        let thread = std::thread::spawn(move || debounce_loop(&rx, &roots, debounce, on_change));
        Ok(Self {
            watcher: Some(watcher),
            thread: Some(thread),
        })
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        // Dropping the notify watcher drops the sender, so the thread sees `Disconnected`.
        drop(self.watcher.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The canonical roots the debounce thread classifies paths against.
struct Roots {
    workdir: PathBuf,
    extra: Option<PathBuf>,
}

/// Idles until a relevant event, then waits for `debounce` of quiet and fires once.
/// Returns when the channel closes, without firing for a pending burst.
fn debounce_loop(rx: &EventRx, roots: &Roots, debounce: Duration, on_change: impl Fn()) {
    loop {
        if !wait_for_relevant(rx, roots) {
            return;
        }
        loop {
            match rx.recv_timeout(debounce) {
                // Any message, relevant or not, restarts the quiet window.
                Ok(Ok(_)) => {}
                Ok(Err(e)) => log_error(&e),
                Err(RecvTimeoutError::Timeout) => {
                    on_change();
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

/// Blocks until a relevant event arrives (`true`) or the channel closes (`false`).
fn wait_for_relevant(rx: &EventRx, roots: &Roots) -> bool {
    loop {
        match rx.recv() {
            Ok(Ok(event)) if is_relevant_event(roots, &event) => return true,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => log_error(&e),
            Err(_) => return false,
        }
    }
}

fn log_error(error: &notify::Error) {
    eprintln!("file watcher error: {error}");
}

/// Access events are noise; otherwise one relevant path (or none reported) is enough,
/// so a rename of `index.lock` onto `index` still counts.
fn is_relevant_event(roots: &Roots, event: &Event) -> bool {
    let extra = roots.extra.as_deref();
    !matches!(event.kind, EventKind::Access(_))
        && (event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|p| is_relevant(&roots.workdir, extra, p)))
}

/// Whether a change at `path` should refresh the UI. Under `workdir`: false under
/// `.git/objects` and for `*.lock` files under `.git`. Under `extra` (a common dir):
/// false under `objects/` and for any `*.lock` file. Paths outside both roots are
/// conservatively relevant.
pub fn is_relevant(workdir: &Path, extra: Option<&Path>, path: &Path) -> bool {
    if let Ok(rel) = path.strip_prefix(workdir) {
        if rel.starts_with(".git/objects") {
            return false;
        }
        return !(rel.starts_with(".git") && is_lock(rel));
    }
    match extra.and_then(|e| path.strip_prefix(e).ok()) {
        Some(rel) => !(rel.starts_with("objects") || is_lock(rel)),
        None => true,
    }
}

fn is_lock(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "lock")
}
