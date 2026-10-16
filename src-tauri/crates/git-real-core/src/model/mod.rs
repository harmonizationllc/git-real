//! Plain data types exchanged with the app layer.

mod progress;
mod repo;

pub use progress::{Progress, ProgressPhase};
pub use repo::RepoSummary;
