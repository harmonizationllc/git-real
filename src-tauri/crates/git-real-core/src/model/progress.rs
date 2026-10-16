//! Progress reporting types for long-running Git operations.

use serde::{Deserialize, Serialize};

/// The stage of a Git operation that a progress report refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressPhase {
    Counting,
    Compressing,
    Receiving,
    Resolving,
    CheckingOut,
    Other,
}

/// One progress update parsed from Git output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: ProgressPhase,
    /// Completion percentage in `0..=100`, when the line carried one.
    pub percent: Option<u8>,
    pub message: String,
}
