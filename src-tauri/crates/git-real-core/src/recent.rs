//! Most-recently-opened repository list. Pure logic: no I/O and no clock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::model::RecentEntry;

/// Maximum number of entries kept in the list.
pub const MAX_ENTRIES: usize = 20;

/// Recently opened repositories, newest first.
///
/// Deserialization accepts only a JSON object, tolerates a missing `entries`
/// key, and ignores unknown keys.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "Wire")]
pub struct RecentRepos {
    entries: Vec<RecentEntry>,
}

/// Deserialization shape for [`RecentRepos`]. The flattened catch-all makes
/// serde parse a map only, so a bare array is rejected rather than read as an
/// empty positional list.
#[derive(Deserialize)]
struct Wire {
    #[serde(default)]
    entries: Vec<RecentEntry>,
    #[serde(flatten)]
    _unknown: BTreeMap<String, IgnoredAny>,
}

impl From<Wire> for RecentRepos {
    fn from(wire: Wire) -> Self {
        Self {
            entries: wire.entries,
        }
    }
}

impl RecentRepos {
    /// Records that `path` was opened, moving it to the front of the list.
    ///
    /// An existing entry for the same path is replaced. The list is truncated
    /// to [`MAX_ENTRIES`] after deduplication.
    pub fn touch(&mut self, path: PathBuf, name: String, now: u64) {
        self.entries.retain(|e| e.path != path);
        self.entries.insert(
            0,
            RecentEntry {
                path,
                name,
                last_opened: now,
            },
        );
        self.entries.truncate(MAX_ENTRIES);
    }

    /// Removes the entry for `path`, returning whether one was present.
    pub fn remove(&mut self, path: &Path) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.path != path);
        self.entries.len() != before
    }

    /// Entries ordered from most to least recently touched.
    pub fn entries(&self) -> &[RecentEntry] {
        &self.entries
    }
}
