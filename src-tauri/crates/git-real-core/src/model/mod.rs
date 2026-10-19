//! Plain data types exchanged with the app layer.

mod branch;
mod commit;
mod diff;
mod history;
mod log;
mod progress;
mod recent;
mod repo;
mod status;

pub use branch::{BranchList, HeadState, LocalBranch, RemoteBranch, RemoteGroup, Tracking};
pub use commit::{CommitConfig, CommitMessage, CommitOutcome, SigningFormat};
pub use diff::{
    DiffLine, DiffLineKind, DiffOptions, DiffScope, DiffSide, FileDiff, Hunk, HunkAction,
    HunkSelection, TextEncoding,
};
pub use history::{Blame, BlameHunk, CommitFile, FileHistoryEntry};
pub use log::{
    CommitDetail, GraphEdge, GraphRow, LogPage, LogSummary, RefKind, RefLabel, ResetMode, Signature,
};
pub use progress::{Progress, ProgressPhase};
pub use recent::RecentEntry;
pub use repo::RepoSummary;
pub use status::{ChangeKind, StatusEntry, WorkingTreeStatus};
