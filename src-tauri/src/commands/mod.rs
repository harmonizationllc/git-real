//! Tauri command handlers.

pub mod repo;

use crate::error::{AppError, AppErrorKind};

/// Runs blocking work on Tauri's blocking pool, mapping a join failure to an `Io` error.
pub async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError {
            kind: AppErrorKind::Io,
            message: e.to_string(),
        })?
}
