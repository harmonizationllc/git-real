//! In-memory registry of open repository sessions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use git_real_core::RepoSession;

/// Opaque handle the front end uses to refer to an open repository.
pub type RepoId = u64;

struct Entry {
    /// Cached so `find_by_path` never has to lock a session.
    path: PathBuf,
    session: Arc<Mutex<RepoSession>>,
}

/// Thread-safe map from [`RepoId`] to open sessions. Ids start at 1 and are never reused.
pub struct RepoRegistry {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<RepoId, Entry>>,
}

impl Default for RepoRegistry {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl RepoRegistry {
    fn entries(&self) -> MutexGuard<'_, HashMap<RepoId, Entry>> {
        // Each critical section is a lookup and at most one insert, so it never leaves the map
        // half-mutated and a poisoned map is still consistent.
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stores the session and returns its new id. Does not deduplicate by path.
    pub fn register(&self, session: RepoSession) -> RepoId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Entry {
            path: session.path().to_path_buf(),
            session: Arc::new(Mutex::new(session)),
        };
        self.entries().insert(id, entry);
        id
    }

    /// Returns the id of the session already registered at this session's path (`false`),
    /// or registers it and returns a fresh id (`true`). Lookup and insert share one lock.
    pub fn register_or_find(&self, session: RepoSession) -> (RepoId, bool) {
        let path = session.path().to_path_buf();
        let outcome = {
            let mut entries = self.entries();
            match entries.iter().find(|(_, e)| e.path == path) {
                Some((id, _)) => Err((*id, session)),
                None => {
                    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                    let entry = Entry {
                        path,
                        session: Arc::new(Mutex::new(session)),
                    };
                    entries.insert(id, entry);
                    Ok(id)
                }
            }
        };
        match outcome {
            Ok(id) => (id, true),
            // The guard is released, so the duplicate session drops outside the registry lock.
            Err((id, _duplicate)) => (id, false),
        }
    }

    pub fn get(&self, id: RepoId) -> Option<Arc<Mutex<RepoSession>>> {
        self.entries().get(&id).map(|e| Arc::clone(&e.session))
    }

    /// Returns whether a session with this id was registered.
    pub fn remove(&self, id: RepoId) -> bool {
        self.entries().remove(&id).is_some()
    }

    /// Finds a session by exact path equality with its (canonical) session path.
    pub fn find_by_path(&self, path: &Path) -> Option<RepoId> {
        self.entries()
            .iter()
            .find(|(_, e)| e.path == path)
            .map(|(id, _)| *id)
    }
}
