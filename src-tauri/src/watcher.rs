//! Debounced recursive file watcher for an open repository's working tree.
//!
//! Knows nothing about Tauri or repo ids: the caller passes a plain `on_change` closure.

use std::path::Path;
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
    /// Starts a recursive watch on `workdir`, firing `on_change` after `debounce` of quiet.
    pub fn start(
        workdir: &Path,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let workdir = workdir.canonicalize().map_err(notify::Error::io)?;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx)?;
        watcher.watch(&workdir, RecursiveMode::Recursive)?;
        let thread = std::thread::spawn(move || debounce_loop(&rx, &workdir, debounce, on_change));
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

/// Idles until a relevant event, then waits for `debounce` of quiet and fires once.
/// Returns when the channel closes, without firing for a pending burst.
fn debounce_loop(rx: &EventRx, workdir: &Path, debounce: Duration, on_change: impl Fn()) {
    loop {
        if !wait_for_relevant(rx, workdir) {
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
fn wait_for_relevant(rx: &EventRx, workdir: &Path) -> bool {
    loop {
        match rx.recv() {
            Ok(Ok(event)) if is_relevant_event(workdir, &event) => return true,
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
fn is_relevant_event(workdir: &Path, event: &Event) -> bool {
    !matches!(event.kind, EventKind::Access(_))
        && (event.paths.is_empty() || event.paths.iter().any(|p| is_relevant(workdir, p)))
}

/// Whether a change at `path` should refresh the UI: false under `.git/objects` and for
/// `*.lock` files under `.git`. Paths outside `workdir` are conservatively relevant.
pub fn is_relevant(workdir: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(workdir) else {
        return true;
    };
    if rel.starts_with(".git/objects") {
        return false;
    }
    !(rel.starts_with(".git") && rel.extension().is_some_and(|ext| ext == "lock"))
}
