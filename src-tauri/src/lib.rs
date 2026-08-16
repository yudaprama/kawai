pub mod auth;
mod commands;
pub mod logic;
pub mod logging;

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
        .plugin(tauri_plugin_opener::init())
        .manage(commands::new_registry())
        .manage(verifier)
        .manage(auth::new_session());

    #[cfg(feature = "litert")]
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
            commands::local_load_model,
            commands::local_chat,
            commands::local_llm_reset,
            commands::local_llm_set_thinking,
            commands::local_llm_unload,
            commands::frontend_log
        ]);

    #[cfg(not(feature = "litert"))]
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
            commands::frontend_log
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
