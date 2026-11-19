//! Android package-installer bridge for the app self-update
//! (`logic/update.rs` carries the pure download side).
//!
//! Pure JNI over framework + `androidx.core.content.FileProvider` APIs — no
//! Kotlin class, so no R8 keep rule or dex check rides on this module (the
//! FileProvider *provider node* itself already ships in the generated
//! manifest; tauri declares it for plugin use).
//!
//! Flow of `install_apk`:
//! 1. API 26+: if the per-app "install unknown apps" switch is off, open
//!    `ACTION_MANAGE_UNKNOWN_APP_SOURCES` for this package and report
//!    `install_permission_required` — the UI translates it and the user taps
//!    Update again after granting.
//! 2. `FileProvider.getUriForFile` a `content://` URI for the downloaded APK
//!    (covered by `res/xml/file_paths.xml`: `<files-path name="updates"
//!    path="updates/" />`, the `<data_root>/updates/` download dir).
//! 3. Fire `ACTION_INSTALL_PACKAGE` with `FLAG_GRANT_READ_URI_PERMISSION` +
//!    `NEW_TASK` — Android shows its own confirm dialog, verifies the APK
//!    signature against the installed app, and takes over from there.
//!
//! `find_class` cannot see APK classes from a native thread (it searches the
//! SYSTEM class loader), so `FileProvider` is looked up through the app class
//! loader carried by `ndk-context` — the same pattern `android_foreground`
//! and `webview_engine` use. Framework classes (`android.*`, `java.io.*`) are
//! visible to `find_class` directly.

use std::path::Path;

/// Open the Play listing for the play channel's update action (the `market://`
/// deep link, with the https listing as fallback).
#[cfg(target_os = "android")]
pub fn open_play_store() -> Result<(), String> {
    imp::open_play_store()
}

/// Hand a downloaded, sha256-verified APK to the system package installer.
/// Only callable on Android — the web wrapper never installs.
#[cfg(target_os = "android")]
pub fn install_apk(path: &Path) -> Result<(), String> {
    imp::install(path)
}

#[cfg(not(target_os = "android"))]
pub fn install_apk(_path: &Path) -> Result<(), String> {
    Err("APK installation is only possible on Android".to_string())
}

#[cfg(not(target_os = "android"))]
pub fn open_play_store() -> Result<(), String> {
    Err("the Play Store is only reachable on Android".to_string())
}

#[cfg(target_os = "android")]
mod imp {
    use jni::{
        jni_sig, jni_str,
        objects::{Global, JClass, JClassLoader, JObject, JString},
        Env, JValue, JavaVM,
    };
    use std::path::Path;
    use std::sync::OnceLock;

    /// `androidx.core.content.FileProvider` — an APK class, resolved through
    /// the app class loader and cached as a global ref (valid on every
    /// attached thread). `OnceLock`, not `LazyLock`: initialization needs a
    /// live JNI env, so it can only happen on the first call.
    static FILE_PROVIDER: OnceLock<Global<JClass<'static>>> = OnceLock::new();

    const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x1;
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

    pub(super) fn install(path: &Path) -> Result<(), String> {
        let path = path.to_string_lossy().into_owned();
        match with_env(|env| install_with_env(env, &path)) {
            Ok(true) => Ok(()),
            Ok(false) => Err("install_permission_required".to_string()),
            Err(e) => Err(format!("apk installer launch failed: {e}")),
        }
    }

    pub(super) fn open_play_store() -> Result<(), String> {
        with_env(|env| {
            env.with_local_frame(8, |env| {
                let context = app_context(env)?;
                let package = package_name(env, &context)?;
                // The market:// deep link is the canonical route; the https
                // listing is the fallback (no Play Store app on the device).
                let market = format!("market://details?id={package}");
                if view(env, &context, &market).is_ok() {
                    return Ok(());
                }
                view(
                    env,
                    &context,
                    &format!("https://play.google.com/store/apps/details?id={package}"),
                )
            })
        })
        .map_err(|e| format!("play store open failed: {e}"))
    }

    /// `Ok(true)` = installer launched; `Ok(false)` = the install-unknown-apps
    /// settings page was opened instead (grant missing).
    fn install_with_env(env: &mut Env<'_>, path: &str) -> jni::errors::Result<bool> {
        env.with_local_frame(12, |env| {
            let context = app_context(env)?;
            // API 26+: installs from this app need the per-app "install
            // unknown apps" switch. Without it the installer intent is a
            // silent no-op — open the settings page and tell the UI.
            if sdk_int(env)? >= 26 && !can_request_installs(env, &context)? {
                open_unknown_sources_settings(env, &context)?;
                return Ok(false);
            }
            let package = package_name(env, &context)?;
            let authority = env.new_string(format!("{}.fileprovider", package))?;
            let file_class = env.find_class(jni_str!("java/io/File"))?;
            let path_str = env.new_string(path)?;
            let file = env.new_object(
                &file_class,
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::from(&path_str)],
            )?;
            let provider = file_provider_class(env)?;
            let uri = env
                .call_static_method(
                    provider,
                    jni_str!("getUriForFile"),
                    jni_sig!(
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;"
                    ),
                    &[
                        JValue::Object(&context),
                        JValue::from(&authority),
                        JValue::Object(&file),
                    ],
                )?
                .l()?;
            let mime = env.new_string("application/vnd.android.package-archive")?;
            let intent_class = env.find_class(jni_str!("android/content/Intent"))?;
            let action = env.new_string("android.intent.action.INSTALL_PACKAGE")?;
            let intent = env.new_object(
                &intent_class,
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::from(&action)],
            )?;
            env.call_method(
                &intent,
                jni_str!("setDataAndType"),
                jni_sig!("(Landroid/net/Uri;Ljava/lang/String;)V"),
                &[JValue::Object(&uri), JValue::from(&mime)],
            )?;
            env.call_method(
                &intent,
                jni_str!("addFlags"),
                jni_sig!("(I)Landroid/content/Intent;"),
                &[JValue::Int(FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                &context,
                jni_str!("startActivity"),
                jni_sig!("(Landroid/content/Intent;)V"),
                &[JValue::Object(&intent)],
            )?;
            Ok(true)
        })
    }

    fn view(env: &mut Env<'_>, context: &JObject<'_>, uri: &str) -> jni::errors::Result<()> {
        env.with_local_frame(8, |env| {
            let uri_class = env.find_class(jni_str!("android/net/Uri"))?;
            let uri_str = env.new_string(uri)?;
            let parsed = env
                .call_static_method(
                    &uri_class,
                    jni_str!("parse"),
                    jni_sig!("(Ljava/lang/String;)Landroid/net/Uri;"),
                    &[JValue::from(&uri_str)],
                )?
                .l()?;
            let intent_class = env.find_class(jni_str!("android/content/Intent"))?;
            let action = env.new_string("android.intent.action.VIEW")?;
            let intent = env.new_object(
                &intent_class,
                jni_sig!("(Ljava/lang/String;Landroid/net/Uri;)V"),
                &[JValue::from(&action), JValue::Object(&parsed)],
            )?;
            env.call_method(
                &intent,
                jni_str!("addFlags"),
                jni_sig!("(I)Landroid/content/Intent;"),
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                context,
                jni_str!("startActivity"),
                jni_sig!("(Landroid/content/Intent;)V"),
                &[JValue::Object(&intent)],
            )?;
            Ok(())
        })
    }

    fn open_unknown_sources_settings(
        env: &mut Env<'_>,
        context: &JObject<'_>,
    ) -> jni::errors::Result<()> {
        env.with_local_frame(8, |env| {
            let settings = env.find_class(jni_str!("android/provider/Settings"))?;
            let action = env
                .get_static_field(
                    &settings,
                    jni_str!("ACTION_MANAGE_UNKNOWN_APP_SOURCES"),
                    jni_sig!("Ljava/lang/String;"),
                )?
                .l()?;
            let action: JString = env.cast_local::<JString>(action)?;
            let package = package_name(env, context)?;
            let package_uri = env.new_string(format!("package:{package}"))?;
            let uri_class = env.find_class(jni_str!("android/net/Uri"))?;
            let parsed = env
                .call_static_method(
                    &uri_class,
                    jni_str!("parse"),
                    jni_sig!("(Ljava/lang/String;)Landroid/net/Uri;"),
                    &[JValue::from(&package_uri)],
                )?
                .l()?;
            let intent_class = env.find_class(jni_str!("android/content/Intent"))?;
            let intent = env.new_object(
                &intent_class,
                jni_sig!("(Ljava/lang/String;Landroid/net/Uri;)V"),
                &[JValue::from(&action), JValue::Object(&parsed)],
            )?;
            env.call_method(
                &intent,
                jni_str!("addFlags"),
                jni_sig!("(I)Landroid/content/Intent;"),
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                context,
                jni_str!("startActivity"),
                jni_sig!("(Landroid/content/Intent;)V"),
                &[JValue::Object(&intent)],
            )?;
            Ok(())
        })
    }

    fn can_request_installs(env: &mut Env<'_>, context: &JObject<'_>) -> jni::errors::Result<bool> {
        let pm = env
            .call_method(
                context,
                jni_str!("getPackageManager"),
                jni_sig!("()Landroid/content/pm/PackageManager;"),
                &[],
            )?
            .l()?;
        env.call_method(
            &pm,
            jni_str!("canRequestPackageInstalls"),
            jni_sig!("()Z"),
            &[],
        )?
        .z()
    }

    fn sdk_int(env: &mut Env<'_>) -> jni::errors::Result<i32> {
        let version = env.find_class(jni_str!("android/os/Build$VERSION"))?;
        env.get_static_field(&version, jni_str!("SDK_INT"), jni_sig!("I"))?
            .i()
    }

    fn package_name(env: &mut Env<'_>, context: &JObject<'_>) -> jni::errors::Result<String> {
        let name = env
            .call_method(
                context,
                jni_str!("getPackageName"),
                jni_sig!("()Ljava/lang/String;"),
                &[],
            )?
            .l()?;
        let name: JString = env.cast_local::<JString>(name)?;
        let text: String = name.mutf8_chars(env)?.into();
        Ok(text)
    }

    fn file_provider_class(env: &mut Env<'_>) -> jni::errors::Result<&'static Global<JClass<'static>>> {
        if let Some(class) = FILE_PROVIDER.get() {
            return Ok(class);
        }
        let ctx = ndk_context::android_context();
        let context = unsafe { JObject::from_raw(env, ctx.context().cast()) };
        let loader = env
            .call_method(
                &context,
                jni_str!("getClassLoader"),
                jni_sig!("()Ljava/lang/ClassLoader;"),
                &[],
            )?
            .l()?;
        let loader: JClassLoader = env.cast_local::<JClassLoader>(loader)?;
        let name = env.new_string("androidx.core.content.FileProvider")?;
        let class: JClass = loader.load_class(env, name)?;
        let global = env.new_global_ref(class)?;
        Ok(FILE_PROVIDER.get_or_init(|| global))
    }

    fn app_context<'local>(env: &mut Env<'local>) -> jni::errors::Result<JObject<'local>> {
        let ctx = ndk_context::android_context();
        Ok(unsafe { JObject::from_raw(env, ctx.context().cast()) })
    }

    /// Attach the calling (tokio worker) thread to the JVM for the call. A
    /// thread that is already attached only pays a thread-local check.
    fn with_env<T>(f: impl FnOnce(&mut Env<'_>) -> jni::errors::Result<T>) -> jni::errors::Result<T> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
        vm.attach_current_thread(f)
    }
}
