pub mod auth;
mod commands;
pub mod logging;
pub mod logic;

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
        .manage(commands::new_registry())
        .manage(verifier)
        .manage(auth::new_session())
        .setup(|app| {
            // Inject office engine directories from the Tauri app paths
            // (env overrides still win — see logic::office). Resolution:
            // resource dir first, exe-dir sibling as dev fallback.
            #[cfg(feature = "office")]
            {
                use tauri::Manager;
                if let Ok(res) = app.path().resource_dir() {
                    logic::office::set_bin_dir(res.join("office-bin"));
                    logic::office::set_runtime_dir(res.join("office-runtime"));
                }
                if let Ok(data) = app.path().app_data_dir() {
                    // One per-user data root: <app_data>/<user_id>/ holds
                    // kawai.db + docs/ (office store defaults into it).
                    logic::db::set_data_root(data);
                }
            }
            #[cfg(not(feature = "office"))]
            let _ = &app;
            Ok(())
        });

    // The office ops exist only with "office"; agent_chat only with "litert".
    // Four literal lists keep generate_handler! static per feature combo.
    #[cfg(all(feature = "litert", feature = "office"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::logout,
        commands::whoami,
        commands::create_note,
        commands::list_notes,
        commands::stream_notes,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        #[cfg(feature = "cloudflare_title")]
        commands::generate_session_title,
        commands::local_load_model,
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
        commands::agent_chat,
        commands::frontend_log
    ]);

    #[cfg(all(feature = "litert", not(feature = "office")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::logout,
        commands::whoami,
        commands::create_note,
        commands::list_notes,
        commands::stream_notes,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        #[cfg(feature = "cloudflare_title")]
        commands::generate_session_title,
        commands::local_load_model,
        commands::local_chat,
        commands::local_llm_reset,
        commands::local_llm_set_thinking,
        commands::local_llm_unload,
        commands::local_llm_get_test_tools,
        commands::agent_chat,
        commands::frontend_log
    ]);

    #[cfg(all(not(feature = "litert"), feature = "office"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::logout,
        commands::whoami,
        commands::create_note,
        commands::list_notes,
        commands::stream_notes,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        #[cfg(feature = "cloudflare_title")]
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
        commands::frontend_log
    ]);

    #[cfg(not(any(feature = "litert", feature = "office")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::generate_activity,
        commands::cancel_stream,
        commands::set_session,
        commands::logout,
        commands::whoami,
        commands::create_note,
        commands::list_notes,
        commands::stream_notes,
        commands::create_chat_session,
        commands::list_chat_sessions,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::delete_chat_session,
        #[cfg(feature = "cloudflare_title")]
        commands::generate_session_title,
        commands::frontend_log
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
