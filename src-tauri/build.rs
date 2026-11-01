fn main() {
    // Android: the C++ objects in the CDylib (MNN, pulled in by the
    // OCR/TTS stack via rust-paddle-ocr) reference libc++ runtime symbols
    // (_Znwm, _ZTISt12length_error, …) that nothing in the dependency tree
    // defines — bionic has no libc++ at all. They used to resolve against
    // liblitert-lm.so, which exported the libc++ it links statically, until
    // upstream's c/litert_lm_c_api_linux.lds version script started hiding
    // everything but litert_lm_*; System.loadLibrary then died with `cannot
    // locate symbol "_ZTISt12length_error"`.
    //
    // Declaring the NDK's shared libc++ here does two things: it puts a
    // DT_NEEDED libc++_shared.so on the CDylib (so the loader resolves those
    // symbols), and it is what makes cargo-mobile2 stage the NDK's
    // libc++_shared.so into jniLibs — its symlink_libs only copies a library
    // whose name appears in the built .so's DT_NEEDED list
    // (src/android/target.rs → ndk.required_libs). Without this line the APK
    // contains no libc++ runtime at all.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=dylib=c++_shared");
    }

    // Desktop only: tauri_build is required for the Tauri shell. Skip when
    // building the standalone `kawai-web` ( --no-default-features --features web ).
    if std::env::var("CARGO_FEATURE_DESKTOP").is_err() {
        return;
    }
    // Windows only: tauri.windows.conf.json's bundle.resources entries.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        clear_dll_readonly();
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
            // Linux: tauri-litert.json installs the .so files into /usr/lib
            // (deb and AppImage alike) while the binary lives in usr/bin —
            // from the binary the libs are one level up ($ORIGIN/lib would
            // resolve to usr/bin/lib, which does not exist).
            "linux" => {
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
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

/// `tauri_build` copies `bundle.resources` into `<target>/<profile>/` with
/// `fs::copy`, which on Windows preserves `FILE_ATTRIBUTE_READONLY`. The staged
/// LiteRT DLLs come out of bazel read-only (MSYS `cp` keeps bazel's mode), so
/// the first copy leaves a read-only `litert-lm.dll` in the target dir and
/// every later build-script run — a feature-set change, or a run after a
/// rust-cache restore — fails with `Access is denied. (os error 5)`. Drop the
/// attribute on the staged DLLs and on their target-dir copies first.
fn clear_dll_readonly() {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    dirs.push(std::path::Path::new(&manifest).join("../cognee-litert-lm/native"));
    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out → <target>/<profile>.
    if let Some(out) = std::env::var_os("OUT_DIR") {
        let out = std::path::PathBuf::from(out);
        if let Some(profile) = out.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            dirs.push(profile.to_path_buf());
        }
    }
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dll") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let mut perm = meta.permissions();
            if perm.readonly() {
                perm.set_readonly(false);
                let _ = std::fs::set_permissions(&path, perm);
            }
        }
    }
}
