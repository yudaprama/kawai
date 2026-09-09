fn main() {
    kawai_lib::auth::load_dotenv();
    // Probe the APP's actual replica: same data root the Tauri shell injects.
    // Without this, examples resolve to <temp>/kawai and test a different
    // file than the app (cost days of contradictory debugging).
    if let Some(dir) = kawai_paths::tauri_app_data_dir(kawai_paths::APP_IDENTIFIER) {
        kawai_paths::set_data_root(dir);
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let cfg = kawai_tool_catalog::RemoteConfig::from_env().unwrap();
        let t0 = std::time::Instant::now();
        let catalog = kawai_tool_catalog::Catalog::open_default(&cfg).await.unwrap();
        println!("[t] open: {:?}", t0.elapsed());
        let t1 = std::time::Instant::now();
        match catalog.sync().await {
            Ok(n) => println!("[t] sync: {n} frames in {:?}", t1.elapsed()),
            Err(e) => println!("[t] sync ERR in {:?}: {e}", t1.elapsed()),
        }
        let names = catalog.list_names().await.unwrap();
        println!("[t] local rows: {}", names.len());
        println!("[t] has weather: {}", names.iter().any(|n| n == "get_weather"));
    });
}
