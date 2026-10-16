use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// A lightweight description of an open repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: PathBuf,
    pub name: String,
    pub head_branch: Option<String>,
    pub is_bare: bool,
}
