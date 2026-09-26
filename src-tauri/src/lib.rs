pub mod agent_registry;
pub mod auth;
#[cfg(feature = "desktop")]
mod commands;
pub mod logging;
// Consumed by the Monad hot-wallet logic, which compiles under the `monad`
// feature; standalone it would be dead weight.
#[cfg_attr(not(feature = "monad"), allow(dead_code))]
#[cfg(feature = "desktop")]
mod keychain;
pub mod logic;
#[cfg(feature = "desktop")]
pub mod native_notifications;

#[cfg(feature = "litert")]
pub mod supervisor;

#[cfg(all(feature = "litert", feature = "desktop"))]
fn supervisor_pending_state() -> crate::supervisor::PendingConfirmations {
    crate::supervisor::PendingConfirmations::default()
}

#[cfg(all(not(feature = "litert"), feature = "desktop"))]
fn supervisor_pending_state() -> () {
    ()
}

#[cfg(feature = "desktop")]
pub mod webview_engine;

#[cfg(feature = "web")]
pub mod web;

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    auth::load_dotenv();
    logging::init();
    kawai_telemetry::init();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::new_registry())
        .manage(auth::new_session())
        .manage(supervisor_pending_state())
        .setup(|app| {
            // Stamp the release version (tauri.conf.json) onto remote telemetry
            // labels before any WARN/ERROR can ship.
            kawai_telemetry::set_app_version(
                app.config().version.clone().unwrap_or_else(|| "unknown".into()),
            );
            // Inject office engine directories from the Tauri app paths
            // (env overrides still win — see logic::office). Resolution:
            // resource dir first, exe-dir sibling as dev fallback.
            {
                use tauri::Manager;
                if let Ok(data) = app.path().app_data_dir() {
                    // One per-user data root: <app_data>/<user_id>/ holds
                    // kawai.db + docs/ (office store defaults into it).
                    // On-device models (LiteRT embedder, OCR, TTS) live in
                    // the app data dir — the home-derived ~/.kawai/models
                    // is unwritable in mobile sandboxes. (Models first:
                    // set_data_root consumes `data`.)
                    kawai_paths::set_models_dir(data.join("models"));
                    logic::db::set_data_root(data);
                // Auto-restore the previous session from the persisted worker
                // token (no password prompt after a restart, until it expires).
                if let Some(email) = logic::local_auth::restore_session() {
                    if let Ok(mut guard) = app.state::<crate::auth::Session>().write() {
                        *guard = Some(email.clone());
                    }
                    // Same attribution as sign-in: the restored session owns
                    // this process's generation metrics.
                    kawai_telemetry::set_current_user(Some(&email));
                    // Seamless location inference: execute the same
                    // get_ip_location tool the LLM uses, upsert one
                    // low-confidence `inferred` memory. Silent on
                    // failure/offline; never blocks startup.
                    tauri::async_runtime::spawn(async move {
                        crate::agent_registry::location_sync_via_tool(&email).await;
                    });
                }
                }
                // Warm the deck-template registry cache in the background
                // (best-effort; offline silently degrades to bundled packs).
                tauri::async_runtime::spawn(async {
                    kawai_office::templates::prefetch_registry().await;
                });
                // Sync the tool catalog NOW, not lazily at the first
                // plan_task: a cold sync contending with engine startup timed
                // out at the 15 s plan-time budget repeatedly, leaving the
                // planner searching a stale replica frozen at an old catalog
                // (83 tools vs 144 — the specialist tools it needed were not
                // in the corpus at all). Shared instance + serialized syncs
                // live in supervisor (the plan-time path uses the same one).
                #[cfg(feature = "litert")]
                crate::supervisor::prefetch_tool_catalog();
                // Warm the device cli-catalog in the background too (no-op
                // without the on-device embedder): scan → reconcile → embed
                // lands before the first plan_task instead of racing it.
                kawai_cli::ensure_catalog_init();
            }
            // Tier-0 web read engine: hidden webview owned by the shell.
            // kawai-web never registers one (Cloudflare-only there).
            let engine: std::sync::Arc<dyn webread::scrape::WebViewFetch> = std::sync::Arc::new(
                webview_engine::TauriWebViewFetch::new(app.handle().clone()),
            );
            webread::set_webview_engine(Some(engine.clone()));
            // StockTwits sits behind Cloudflare bot management — plain HTTP
            // gets a JS challenge. Route its fetches through the same hidden
            // webview (real browser fingerprint), direct reqwest as fallback.
            finance::stocktwits::set_fetcher(std::sync::Arc::new(move |url| {
                let engine = engine.clone();
                Box::pin(async move {
                    // The extractor returns the page's raw body text — for a
                    // JSON endpoint Safari renders exactly the JSON payload.
                    engine
                        .eval_page(&url, "JSON.stringify(document.body.innerText)")
                        .await
                        .map_err(|e| e.0)
                })
            }));
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
        commands::list_recent_runs,
        commands::rename_chat_session,
        commands::set_chat_session_archived,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::update_chat_message,
        commands::delete_chat_session,
        commands::archive_stale_sessions,
        commands::generate_session_title,
        commands::skill_create,
        commands::skill_list,
        commands::suggest_followups,
        commands::skill_get,
        commands::skill_update,
        commands::skill_delete,
        commands::memory_create,
        commands::memory_location_sync,
        commands::memory_list,
        commands::memory_update,
        commands::memory_delete,
        commands::experience_list,
        commands::experience_delete,
        commands::onboarding_status,
        commands::onboarding_run,
        commands::onboarding_skip,
        commands::onboarding_reset,
        commands::onboarding_import_document,
        commands::facet_list,
        commands::facet_pin,
        commands::facet_forget,
        commands::facet_reset_non_pinned,
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
        commands::get_token_balance,
        commands::get_token_info,
        commands::estimate_gas,
        commands::monad_wallet_address,
        commands::monad_wallet_history,
        commands::monad_wallet_create,
        commands::monad_wallet_sign_message,
        commands::monad_wallet_delete,
        commands::transfer_native,
        commands::transfer_token,
        commands::transfer_usdt,
        commands::deposit_to_vault,
        commands::get_transaction_receipt,
        commands::graph_index_file,
        commands::graph_index_text,
        commands::graph_search,
        commands::graph_list,
        commands::graph_forget,
        commands::graph_stats,
        commands::frontend_log,
        commands::synthesize_speech,

        // ── QRIS top-up (PLAN-qris-topup.md Fase 3) ─────────────────────
        commands::topup_qris_preview,
        commands::topup_qris_claim,
        commands::topup_qris_status,
        commands::topup_balance,
        commands::topup_history,

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
        commands::run_analysis_desk,
        #[cfg(feature = "litert")]
        commands::run_youtube_summary,
        #[cfg(feature = "litert")]
        commands::respond_supervisor_confirmation,
        #[cfg(feature = "litert")]
        commands::plan_task,
        #[cfg(feature = "litert")]
        commands::supervisor_step_output,

        // ── litert + office (knowledge context + rig tools) ─────────────
        #[cfg(feature = "litert")]
        commands::local_llm_get_rig_tools,
        #[cfg(feature = "litert")]
        commands::knowledge_context,

        // ── office ─────────────────────────────────────────────────────
        commands::office_import_file,
        commands::office_list_files,
        commands::export_deliverable,
        commands::office_list_templates,
        commands::office_bind_template,
        commands::office_peek_template,
        commands::office_read_document,
        commands::office_read_deck,
        commands::office_export_deck_html,
        commands::office_export_deck,
        commands::office_export_deck,
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Flush the last telemetry batch (generations queue + OTel
            // providers) before the process drops.
            if let tauri::RunEvent::Exit = event {
                kawai_telemetry::shutdown();
            }
        });
}
