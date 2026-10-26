//! Update-check command: one unauthenticated GET of the GitHub "latest
//! release" endpoint, run off the IPC thread because the transport blocks.

use std::sync::Arc;

use git_real_core::UpdateInfo;
use git_real_core::hosting::http::Transport;
use git_real_core::update;
use tauri::State;

use super::run_blocking;
use crate::error::AppError;

/// The "latest release" endpoint for this repository.
pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/harmonizationllc/git-real/releases/latest";

/// Checks `RELEASES_API_URL` for a release newer than this build. Split from the
/// command so tests can drive it with a fake transport and no Tauri `State`.
pub fn check_for_update_inner(transport: &dyn Transport) -> Result<UpdateInfo, AppError> {
    update::check_for_update(transport, env!("CARGO_PKG_VERSION"), RELEASES_API_URL)
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn check_for_update(
    transport: State<'_, Arc<dyn Transport>>,
) -> Result<UpdateInfo, AppError> {
    let transport = Arc::clone(transport.inner());
    run_blocking(move || check_for_update_inner(&*transport)).await
}
