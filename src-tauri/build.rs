fn main() {
    // For desktop + on-device LLM builds, embed the rpath the bundled app
    // resolves LiteRT-LM shared libraries from. Rustc link args from a
    // dependency (cognee-litert-lm) do NOT propagate to the final binary,
    // so this must be emitted by the app crate itself. Harmless in dev
    // (a dead rpath); dev still supplies RUSTFLAGS for the native/ dir.
    if std::env::var("CARGO_FEATURE_LITERT").is_ok() {
        let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        match target_os.as_str() {
            // macOS: Contents/Frameworks/ (tauri-litert.json places libs there)
            "macos" => {
                println!(
                    "cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks"
                );
            }
            // Linux: lib/ next to the executable (tauri-litert.json places libs there)
            "linux" => {
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib");
            }
            // Windows: no ELF rpath; DLL is co-located via Tauri bundling.
            _ => {}
        }
    }

    tauri_build::build()
}
