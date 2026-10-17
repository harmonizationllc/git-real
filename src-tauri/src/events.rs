//! Events emitted from the backend to the front end.

use git_real_core::{Progress, ProgressSink};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::RepoId;

/// Event name for clone progress updates.
pub const CLONE_PROGRESS: &str = "clone-progress";

/// Payload of a [`CLONE_PROGRESS`] event; `clone_id` lets the UI match it to a clone request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressPayload {
    pub clone_id: u64,
    pub progress: Progress,
}

/// Event name for "something in this repository changed on disk"; the UI refetches.
pub const REPO_CHANGED: &str = "repo-changed";

/// Payload of a [`REPO_CHANGED`] event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChangedPayload {
    pub repo_id: RepoId,
}

/// Forwards clone progress to the front end as [`CLONE_PROGRESS`] events.
pub struct EventProgressSink {
    app: AppHandle,
    clone_id: u64,
}

impl EventProgressSink {
    pub fn new(app: AppHandle, clone_id: u64) -> Self {
        Self { app, clone_id }
    }
}

impl ProgressSink for EventProgressSink {
    fn report(&mut self, progress: Progress) {
        // Progress is best-effort: a closed window must not fail the clone.
        let _ = self.app.emit(
            CLONE_PROGRESS,
            CloneProgressPayload {
                clone_id: self.clone_id,
                progress,
            },
        );
    }
}
