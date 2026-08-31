pub mod agent_registry;
pub mod auth;
mod commands;
pub mod logging;
mod keychain;
pub mod logic;
pub mod native_notifications;

#[cfg(all(feature = "router", feature = "litert"))]
pub mod supervisor;

#[cfg(all(feature = "router", feature = "litert"))]
fn supervisor_pending_state() -> crate::supervisor::PendingConfirmations {
    crate::supervisor::PendingConfirmations::default()
}

#[cfg(not(all(feature = "router", feature = "litert")))]
fn supervisor_pending_state() -> () {
    ()
}

#[cfg(feature = "webread")]
pub mod webview_engine;

#[cfg(feature = "web")]
pub mod web;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    auth::load_dotenv();
    logging::init();
    let verifier = auth::Verifier::from_env();
    if verifier.has_dev_bypass() {
        eprintln!(
            "⚠️  KAWAI_AUTH_DEV_USER_ID set — auth bypassed (dev only, DO NOT use in production)"
        );
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(commands::new_registry())
        .manage(verifier)
        .manage(auth::new_session())
        .manage(supervisor_pending_state())
        .setup(|app| {
            // Inject office engine directories from the Tauri app paths
            // (env overrides still win — see logic::office). Resolution:
            // resource dir first, exe-dir sibling as dev fallback.
            #[cfg(feature = "office")]
            {
                use tauri::Manager;
                if let Ok(data) = app.path().app_data_dir() {
                    // One per-user data root: <app_data>/<user_id>/ holds
                    // kawai.db + docs/ (office store defaults into it).
                    logic::db::set_data_root(data);
                }
            }
            // Tier-0 web read engine: hidden webview owned by the shell.
            // kawai-web never registers one (Cloudflare-only there).
            #[cfg(feature = "webread")]
            webread::set_webview_engine(Some(std::sync::Arc::new(
                webview_engine::TauriWebViewFetch::new(app.handle().clone()),
            )));
            #[cfg(not(any(feature = "office", feature = "webread")))]
            let _ = &app;
            Ok(())
        });

    // The office ops exist only with the "office" feature.
    // Literal lists keep generate_handler! static per feature combo; the
    // analytics ops (sql_profile_*) get their own list — they exist only
    // under the `analytics` feature (which implies office).
    #[cfg(all(feature = "litert", feature = "office", not(feature = "analytics")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::restore_session,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::skill_create,
        commands::skill_list,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::memory_extract,
        commands::generate_session_title,
        commands::local_load_model,
        commands::local_model_status,
        commands::local_chat,
        commands::local_llm_reset,
        commands::local_llm_set_thinking,
        commands::local_llm_unload,
        commands::local_llm_get_test_tools,
        commands::local_llm_get_rig_tools,
        commands::office_import_file,
        commands::office_list_files,
        commands::office_read_document,
        commands::knowledge_context,
        commands::office_export_file,
        commands::office_capabilities,
        commands::office_index_file,
        commands::knowledge_search,
        commands::knowledge_forget,
        commands::list_session_files,
        commands::knowledge_list,
        commands::knowledge_add_to_session,
        commands::knowledge_import_youtube,
        commands::office_delete_file,
        commands::office_restore_backup,
        commands::office_read_file,
        commands::office_export_document,
        commands::tauri_open_file,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::execute_supervisor_plan,
        commands::respond_supervisor_confirmation,
        commands::plan_task,
        commands::frontend_log,
        commands::synthesize_speech,
        native_notifications::notification_permission_state,
        native_notifications::notification_permission_request,
        native_notifications::show_native_notification
    ]);

    #[cfg(all(feature = "litert", feature = "office", feature = "analytics"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::restore_session,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::skill_create,
        commands::skill_list,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::memory_extract,
        commands::generate_session_title,
        commands::local_load_model,
        commands::local_model_status,
        commands::local_chat,
        commands::local_llm_reset,
        commands::local_llm_set_thinking,
        commands::local_llm_unload,
        commands::local_llm_get_test_tools,
        commands::local_llm_get_rig_tools,
        commands::office_import_file,
        commands::office_list_files,
        commands::office_read_document,
        commands::knowledge_context,
        commands::office_export_file,
        commands::office_capabilities,
        commands::office_index_file,
        commands::knowledge_search,
        commands::knowledge_forget,
        commands::list_session_files,
        commands::knowledge_list,
        commands::knowledge_add_to_session,
        commands::knowledge_import_youtube,
        commands::office_delete_file,
        commands::office_restore_backup,
        commands::office_read_file,
        commands::office_export_document,
        commands::tauri_open_file,
        commands::data_preview,
        commands::sql_profile_list,
        commands::sql_profile_save,
        commands::sql_profile_delete,
        commands::sql_profile_test,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::execute_supervisor_plan,
        commands::respond_supervisor_confirmation,
        commands::plan_task,
        commands::frontend_log,
        commands::synthesize_speech,
        native_notifications::notification_permission_state,
        native_notifications::notification_permission_request,
        native_notifications::show_native_notification
    ]);

    #[cfg(all(feature = "litert", not(feature = "office")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::restore_session,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::skill_create,
        commands::skill_list,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::memory_extract,
        commands::generate_session_title,
        commands::local_load_model,
        commands::local_model_status,
        commands::local_chat,
        commands::local_llm_reset,
        commands::local_llm_set_thinking,
        commands::local_llm_unload,
        commands::local_llm_get_test_tools,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::execute_supervisor_plan,
        commands::respond_supervisor_confirmation,
        commands::plan_task,
        commands::frontend_log,
        commands::synthesize_speech,
        native_notifications::notification_permission_state,
        native_notifications::notification_permission_request,
        native_notifications::show_native_notification
    ]);

    #[cfg(all(not(feature = "litert"), feature = "office"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::restore_session,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::skill_create,
        commands::skill_list,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::memory_extract,
        commands::generate_session_title,
        commands::office_import_file,
        commands::office_list_files,
        commands::office_read_document,
        commands::office_export_file,
        commands::office_capabilities,
        commands::office_index_file,
        commands::knowledge_search,
        commands::knowledge_forget,
        commands::list_session_files,
        commands::knowledge_list,
        commands::knowledge_add_to_session,
        commands::knowledge_import_youtube,
        commands::office_delete_file,
        commands::office_restore_backup,
        commands::office_read_file,
        commands::office_export_document,
        commands::tauri_open_file,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::frontend_log,
        commands::synthesize_speech,
        native_notifications::notification_permission_state,
        native_notifications::notification_permission_request,
        native_notifications::show_native_notification
    ]);

    #[cfg(not(any(feature = "litert", feature = "office")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::restore_session,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::skill_create,
        commands::skill_list,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::memory_extract,
        commands::generate_session_title,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::frontend_log,
        commands::synthesize_speech,
        native_notifications::notification_permission_state,
        native_notifications::notification_permission_request,
        native_notifications::show_native_notification
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
