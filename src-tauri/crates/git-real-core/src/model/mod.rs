//! Plain data types exchanged with the app layer.

mod diff;
mod progress;
mod recent;
mod repo;
mod status;

pub use diff::{
    DiffLine, DiffLineKind, DiffOptions, DiffScope, DiffSide, FileDiff, Hunk, HunkAction,
    HunkSelection, TextEncoding,
};
pub use progress::{Progress, ProgressPhase};
pub use recent::RecentEntry;
pub use repo::RepoSummary;
pub use status::{ChangeKind, StatusEntry, WorkingTreeStatus};
