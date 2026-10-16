use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One repository in the recently opened list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: PathBuf,
    pub name: String,
    /// Unix timestamp, in seconds, supplied by the caller.
    pub last_opened: u64,
}
