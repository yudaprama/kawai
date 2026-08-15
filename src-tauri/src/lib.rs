pub mod auth;
mod commands;
pub mod logic;

#[cfg(feature = "web")]
pub mod web;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    auth::load_dotenv();
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
            commands::local_load_model,
            commands::local_chat
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
            commands::stream_notes
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
