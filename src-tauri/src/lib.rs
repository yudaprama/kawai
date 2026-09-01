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
                // Warm the deck-template registry cache in the background
                // (best-effort; offline silently degrades to bundled packs).
                tauri::async_runtime::spawn(async {
                    kawai_office::templates::prefetch_registry().await;
                });
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

    // Single generate_handler! — per-entry #[cfg] replaces the five
    // nearly-identical blocks that were here before.
    let builder = builder.invoke_handler(tauri::generate_handler![
        // ── base (always registered) ───────────────────────────────────
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

        // ── litert + office (knowledge context + rig tools) ─────────────
        #[cfg(all(feature = "litert", feature = "office"))]
        commands::local_llm_get_rig_tools,
        #[cfg(all(feature = "litert", feature = "office"))]
        commands::knowledge_context,

        // ── office ─────────────────────────────────────────────────────
        #[cfg(feature = "office")]
        commands::office_import_file,
        #[cfg(feature = "office")]
        commands::office_list_files,
        #[cfg(feature = "office")]
        commands::office_list_templates,
        #[cfg(feature = "office")]
        commands::office_bind_template,
        #[cfg(feature = "office")]
        commands::office_peek_template,
        #[cfg(feature = "office")]
        commands::office_read_document,
        #[cfg(feature = "office")]
        commands::office_export_file,
        #[cfg(feature = "office")]
        commands::office_capabilities,
        #[cfg(feature = "office")]
        commands::office_index_file,
        #[cfg(feature = "office")]
        commands::knowledge_search,
        #[cfg(feature = "office")]
        commands::knowledge_forget,
        #[cfg(feature = "office")]
        commands::list_session_files,
        #[cfg(feature = "office")]
        commands::knowledge_list,
        #[cfg(feature = "office")]
        commands::knowledge_add_to_session,
        #[cfg(feature = "office")]
        commands::knowledge_import_youtube,
        #[cfg(feature = "office")]
        commands::office_delete_file,
        #[cfg(feature = "office")]
        commands::office_restore_backup,
        #[cfg(feature = "office")]
        commands::office_read_file,
        #[cfg(feature = "office")]
        commands::office_export_document,
        #[cfg(feature = "office")]
        commands::tauri_open_file,

        // ── analytics (implies office) ─────────────────────────────────
        #[cfg(feature = "analytics")]
        commands::data_preview,
        #[cfg(feature = "analytics")]
        commands::sql_profile_list,
        #[cfg(feature = "analytics")]
        commands::sql_profile_save,
        #[cfg(feature = "analytics")]
        commands::sql_profile_delete,
        #[cfg(feature = "analytics")]
        commands::sql_profile_test,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}