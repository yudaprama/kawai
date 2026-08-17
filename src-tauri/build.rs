fn main() {
    // For desktop + on-device LLM builds, embed the rpath the bundled app
    // resolves LiteRT-LM dylibs from (Contents/Frameworks/). Rustc link args
    // from a dependency (cognee-litert-lm) do NOT propagate to the final
    // binary, so this must be emitted by the app crate itself. Harmless in
    // dev (a dead rpath); dev still supplies RUSTFLAGS for the native/ dir.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_FEATURE_LITERT").is_ok()
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    tauri_build::build()
}