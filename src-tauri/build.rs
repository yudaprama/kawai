fn main() {
    // Desktop only: tauri_build is required for the Tauri shell. Skip when
    // building the standalone `kawai-web` ( --no-default-features --features web ).
    if std::env::var("CARGO_FEATURE_DESKTOP").is_err() {
        return;
    }
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
                println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
            }
            // Linux: lib/ next to the executable (tauri-litert.json places libs there)
            "linux" => {
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib");
            }
            // Windows: no ELF rpath; DLL is co-located via Tauri bundling.
            _ => {}
        }
        // Dev/test rpath: the checkout's prepared native/ dir (bundle script
        // + per-target mobile dirs). Lets plain `cargo test` / `cargo run`
        // resolve liblitert-lm.dylib without the RUSTFLAGS rpath the
        // `tauri dev` wrapper injects — rustc-link-arg from THIS build.rs
        // reaches the package's test binaries, which is exactly where the
        // bare `cargo test --features litert` load aborted before. Absolute
        // path baked at build time; dead weight in the bundled app.
        if matches!(target_os.as_str(), "macos" | "linux") {
            let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
            let native = std::path::Path::new(&manifest).join("../cognee-litert-lm/native");
            if native.is_dir() {
                let native = native.canonicalize().unwrap_or(native);
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", native.display());
            }
        }
    }

    tauri_build::build()
}
