//! The port through which long-running operations report progress.

use crate::model::Progress;

/// Receives progress updates from an operation such as a clone.
pub trait ProgressSink: Send {
    fn report(&mut self, progress: Progress);
}
