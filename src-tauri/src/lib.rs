pub mod commands;
pub mod error;
pub mod events;
pub mod recent_store;
pub mod state;
pub mod watcher;

use std::sync::Arc;

use tauri::Manager;

use crate::recent_store::RecentStore;
use crate::state::{RepoRegistry, WatcherRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(RepoRegistry::default()))
        .manage(Arc::new(WatcherRegistry::default()))
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(Arc::new(RecentStore::load(dir.join("recent-repos.json"))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::init_repo,
            commands::repo::clone_repo,
            commands::repo::close_repo,
            commands::repo::list_recent,
            commands::repo::remove_recent,
            commands::repo::check_git_cli,
            commands::worktree::get_status,
            commands::worktree::get_file_diff,
            commands::worktree::get_file_content,
            commands::worktree::stage_paths,
            commands::worktree::unstage_paths,
            commands::worktree::stage_all,
            commands::worktree::unstage_all,
            commands::worktree::discard_paths,
            commands::worktree::apply_hunk,
            commands::worktree::add_to_gitignore,
            commands::commit::get_commit_config,
            commands::commit::get_head_message,
            commands::commit::commit,
            commands::refs::list_branches,
            commands::refs::create_branch,
            commands::refs::rename_branch,
            commands::refs::delete_branch,
            commands::refs::checkout_branch,
            commands::refs::checkout_remote_branch,
            commands::refs::delete_remote_branch,
            commands::log::get_log_summary,
            commands::log::get_log_page,
            commands::log::search_log,
            commands::log::get_commit,
            commands::log::checkout_commit,
            commands::log::reset_to_commit,
            commands::history::list_tracked_files,
            commands::history::get_commit_files,
            commands::history::get_file_history,
            commands::history::get_blame,
            commands::merge::get_operation_state,
            commands::merge::merge_branch,
            commands::merge::rebase_onto,
            commands::merge::cherry_pick,
            commands::merge::revert_commit,
            commands::merge::abort_operation,
            commands::merge::continue_rebase,
            commands::merge::resolve_conflicts,
            commands::merge::write_resolution,
            commands::merge::can_fast_forward,
            commands::merge::rebase_plan,
            commands::merge::rebase_interactive,
            commands::stash::list_stashes,
            commands::stash::get_stash_files,
            commands::stash::stash_push,
            commands::stash::stash_apply,
            commands::stash::stash_pop,
            commands::stash::stash_drop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
