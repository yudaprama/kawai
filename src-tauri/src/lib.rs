pub mod agent_registry;
pub mod auth;
mod commands;
pub mod logging;
mod keychain;
pub mod logic;
pub mod native_notifications;

#[cfg(feature = "litert")]
pub mod supervisor;

#[cfg(feature = "litert")]
fn supervisor_pending_state() -> crate::supervisor::PendingConfirmations {
    crate::supervisor::PendingConfirmations::default()
}

#[cfg(not(feature = "litert"))]
fn supervisor_pending_state() -> () {
    ()
}

pub mod webview_engine;

#[cfg(feature = "web")]
pub mod web;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    auth::load_dotenv();
    logging::init();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::new_registry())
        .manage(auth::new_session())
        .manage(supervisor_pending_state())
        .setup(|app| {
            // Inject office engine directories from the Tauri app paths
            // (env overrides still win — see logic::office). Resolution:
            // resource dir first, exe-dir sibling as dev fallback.
            {
                use tauri::Manager;
                if let Ok(data) = app.path().app_data_dir() {
                    // One per-user data root: <app_data>/<user_id>/ holds
                    // kawai.db + docs/ (office store defaults into it).
                    logic::db::set_data_root(data);
                // Auto-restore the previous session from the persisted worker
                // token (no password prompt after a restart, until it expires).
                if let Some(email) = logic::local_auth::restore_session() {
                    if let Ok(mut guard) = app.state::<crate::auth::Session>().write() {
                        *guard = Some(email);
                    }
                }
                }
                // Warm the deck-template registry cache in the background
                // (best-effort; offline silently degrades to bundled packs).
                tauri::async_runtime::spawn(async {
                    kawai_office::templates::prefetch_registry().await;
                });
            }
            // Tier-0 web read engine: hidden webview owned by the shell.
            // kawai-web never registers one (Cloudflare-only there).
            webread::set_webview_engine(Some(std::sync::Arc::new(
                webview_engine::TauriWebViewFetch::new(app.handle().clone()),
            )));
            Ok(())
        });

    // Single generate_handler! — per-entry #[cfg] replaces the five
    // nearly-identical blocks that were here before.
    let builder = builder.invoke_handler(tauri::generate_handler![
        // ── base (always registered) ───────────────────────────────────
        commands::greet,
        commands::list_agents,
        commands::generate_activity,
        commands::send_verification_email,
        commands::auth_sign_up,
        commands::auth_send_code,
        commands::auth_verify_code,
        commands::auth_sign_in,
        commands::cancel_stream,
        commands::logout,
        commands::whoami,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        commands::generate_session_title,
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
        commands::memory_search,
        commands::memory_consolidate,
        commands::memory_graph_search,
        commands::memory_graph_export,
        commands::memory_scene_extract,
        commands::memory_scene_list,
        commands::memory_persona_generate,
        commands::memory_persona_get,
        commands::codegraph_explore,
        commands::codegraph_status,
        commands::codegraph_is_available,
        commands::codegraph_init,
        commands::check_monad_balance,
        commands::monad_chain_status,
        commands::monad_wallet_address,
        commands::monad_wallet_create,
        commands::monad_wallet_sign_message,
        commands::monad_wallet_delete,
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
        native_notifications::show_native_notification,

        // ── litert (local LLM + supervisor) ────────────────────────────
        #[cfg(feature = "litert")]
        commands::local_load_model,
        #[cfg(feature = "litert")]
        commands::local_model_status,
        #[cfg(feature = "litert")]
        commands::local_chat,
        #[cfg(feature = "litert")]
        commands::local_llm_reset,
        #[cfg(feature = "litert")]
        commands::local_llm_set_thinking,
        #[cfg(feature = "litert")]
        commands::local_llm_unload,
        #[cfg(feature = "litert")]
        commands::local_llm_get_test_tools,
        #[cfg(feature = "litert")]
        commands::execute_supervisor_plan,
        #[cfg(feature = "litert")]
        commands::respond_supervisor_confirmation,
        #[cfg(feature = "litert")]
        commands::plan_task,
        commands::bill_turn,

        // ── litert + office (knowledge context + rig tools) ─────────────
        #[cfg(feature = "litert")]
        commands::local_llm_get_rig_tools,
        #[cfg(feature = "litert")]
        commands::knowledge_context,

        // ── office ─────────────────────────────────────────────────────
        commands::office_import_file,
        commands::office_list_files,
        commands::office_list_templates,
        commands::office_bind_template,
        commands::office_peek_template,
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

        // ── analytics (implies office) ─────────────────────────────────
        commands::data_preview,
        commands::sql_profile_list,
        commands::sql_profile_save,
        commands::sql_profile_delete,
        commands::sql_profile_test,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
