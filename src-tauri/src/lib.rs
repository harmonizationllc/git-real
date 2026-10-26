pub mod commands;
pub mod error;
pub mod events;
pub mod hosting_store;
pub mod main_window;
pub mod recent_store;
pub mod settings_store;
pub mod state;
pub mod watcher;

use std::sync::Arc;

use git_real_core::hosting::Transport;
use git_real_core::hosting::ureq_transport::UreqTransport;
use tauri::{Manager, WindowEvent};

use crate::hosting_store::{HostingStore, KeyringTokenStore};
use crate::recent_store::RecentStore;
use crate::settings_store::SettingsStore;
use crate::state::{RepoRegistry, WatcherRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let transport: Arc<dyn Transport> = Arc::new(UreqTransport::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(RepoRegistry::default()))
        .manage(Arc::new(WatcherRegistry::default()))
        .manage(transport)
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(Arc::new(RecentStore::load(dir.join("recent-repos.json"))));
            app.manage(Arc::new(HostingStore::load(
                dir.join("hosting_accounts.json"),
                Box::new(KeyringTokenStore),
            )));
            let settings = Arc::new(SettingsStore::load(dir.join("settings.json")));
            settings.apply_git_override();
            app.manage(settings.clone());
            main_window::build(app.handle(), &settings)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event
                && let Some(webview) = window.app_handle().get_webview_window(window.label())
            {
                let store = window.state::<Arc<SettingsStore>>();
                main_window::on_close_requested(&webview, &store);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::init_repo,
            commands::repo::clone_repo,
            commands::repo::close_repo,
            commands::repo::list_recent,
            commands::repo::remove_recent,
            commands::repo::check_git_cli,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::reveal_settings_file,
            commands::settings::check_settings_health,
            commands::settings::settings_file_path,
            commands::update::check_for_update,
            commands::tools::open_in_editor,
            commands::tools::open_external_diff,
            commands::tools::open_external_merge,
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
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::tags::push_tag,
            commands::tags::delete_remote_tag,
            commands::remote::fetch,
            commands::remote::fetch_remote,
            commands::remote::pull_default_mode,
            commands::remote::pull,
            commands::remote::push,
            commands::remote::list_remotes,
            commands::remote::add_remote,
            commands::remote::update_remote,
            commands::remote::remove_remote,
            commands::hosting::hosting_list_accounts,
            commands::hosting::hosting_connect,
            commands::hosting::hosting_disconnect,
            commands::hosting::hosting_repo_context,
            commands::hosting::hosting_list_pull_requests,
            commands::hosting::hosting_checkout_pull_request,
            commands::hosting::hosting_repo_info,
            commands::hosting::hosting_list_issues,
            commands::hosting::hosting_list_my_repos,
            commands::hosting::hosting_pull_request_draft,
            commands::hosting::hosting_create_pull_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
