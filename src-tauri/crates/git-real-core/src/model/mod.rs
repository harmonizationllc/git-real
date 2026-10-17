//! Plain data types exchanged with the app layer.

mod progress;
mod recent;
mod repo;
mod status;

pub use progress::{Progress, ProgressPhase};
pub use recent::RecentEntry;
pub use repo::RepoSummary;
pub use status::{ChangeKind, StatusEntry, WorkingTreeStatus};
