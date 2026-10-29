//! Plain data types exchanged with the app layer.

mod branch;
mod commit;
mod diff;
mod history;
mod linked_worktree;
mod log;
mod merge;
mod progress;
mod recent;
mod remote;
mod repo;
mod stash;
mod status;
mod tag;

pub use branch::{BranchList, HeadState, LocalBranch, RemoteBranch, RemoteGroup, Tracking};
pub use commit::{CommitConfig, CommitMessage, CommitOutcome, SigningFormat};
pub use diff::{
    DiffLine, DiffLineKind, DiffOptions, DiffScope, DiffSide, FileDiff, Hunk, HunkAction,
    HunkSelection, TextEncoding,
};
pub use history::{Blame, BlameHunk, CommitFile, FileHistoryEntry};
pub use linked_worktree::{LinkedWorktree, PrunedWorktrees, WorktreeBranch};
pub use log::{
    CommitDetail, GraphEdge, GraphRow, LogPage, LogSummary, RefKind, RefLabel, ResetMode, Signature,
};
pub use merge::{
    CheckoutPrOutcome, ConflictSide, FastForwardCheck, MergeMode, OperationOutcome, OperationState,
    RebaseAction, RebaseCommit, RebaseStep,
};
pub use progress::{Progress, ProgressPhase};
pub use recent::RecentEntry;
pub use remote::{
    NetworkDetail, NetworkErrorKind, PullMode, PullRequestDraft, PushTarget, RemoteInfo,
};
pub use repo::RepoSummary;
pub use stash::{StashEntry, StashFiles, StashOutcome};
pub use status::{ChangeKind, StatusEntry, WorkingTreeStatus};
pub use tag::{TagEntry, TagList};
