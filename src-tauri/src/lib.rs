mod commands;
pub mod logic;

#[cfg(feature = "web")]
pub mod web;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::new_registry())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::generate_activity,
            commands::cancel_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
