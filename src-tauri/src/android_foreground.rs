//! Keeps an in-flight generation out of Android's cached-app freezer.
//!
//! Backgrounding the app is not free: Android freezes a process ~10 s after it
//! enters the cached state, which suspends every thread — the on-device
//! generation stalls mid-token and the remote tier's SSE sockets are torn down
//! under it. A foreground service holds the process in the *foreground service*
//! state instead, so it is never cached, never frozen, and keeps its sockets.
//! The notification Android requires for that is the price.
//!
//! The guard is refcounted and RAII: [`crate::commands::run_streaming`] — the
//! single choke point every streaming op goes through — takes one for the whole
//! stream and drops it on every exit path (finished, error, cancelled).
//! `KawaiForegroundService` owns a partial wake lock, so a run also survives
//! the screen going off. Off Android this is a no-op.
//!
//! What this does NOT cover: removing the task from recents. Android destroys
//! the activity, tao reports the window destroyed, tauri's event loop exits and
//! `main` returns — process gone, service gone with it. Minimize /
//! back-to-recents / screen-off are the states this holds.

/// RAII handle for one in-flight run. The first live handle starts the
/// foreground service; the last one to drop stops it.
pub struct RunGuard(());

impl RunGuard {
    pub fn acquire() -> Self {
        imp::acquire();
        RunGuard(())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        imp::release();
    }
}

#[cfg(target_os = "android")]
mod imp {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;

    use jni::objects::{Global, JClass, JClassLoader, JObject};
    use jni::vm::JavaVM;
    use jni::{jni_sig, jni_str, Env};

    /// Live guards. The service runs iff this is non-zero.
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);

    /// `KawaiForeground` as a global class ref. `Env::find_class` cannot see APK
    /// classes from a native thread (it searches the SYSTEM class loader); the
    /// app class loader carried by `ndk-context` must do the lookup — the same
    /// pattern the `KawaiHeadless` bridge uses. Cached once: the ref is valid on
    /// every attached thread.
    static CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

    pub fn acquire() {
        if ACTIVE.fetch_add(1, Ordering::SeqCst) == 0 {
            // A refused start (background-start restriction, service already
            // torn down) must never take the generation down with it.
            if let Err(e) = start() {
                tracing::warn!("foreground service start failed: {e}");
            }
        }
    }

    pub fn release() {
        if ACTIVE.fetch_sub(1, Ordering::SeqCst) == 1 {
            if let Err(e) = stop() {
                tracing::warn!("foreground service stop failed: {e}");
            }
        }
    }

    fn start() -> jni::errors::Result<()> {
        with_env(|env| {
            let class = foreground_class(env)?;
            env.call_static_method(class, jni_str!("start"), jni_sig!("()V"), &[])?;
            Ok(())
        })
    }

    fn stop() -> jni::errors::Result<()> {
        with_env(|env| {
            let class = foreground_class(env)?;
            env.call_static_method(class, jni_str!("stop"), jni_sig!("()V"), &[])?;
            Ok(())
        })
    }

    /// Attach the calling (tokio worker) thread to the JVM for the call. A
    /// thread that is already attached only pays a thread-local check.
    fn with_env<T>(
        f: impl FnOnce(&mut Env<'_>) -> jni::errors::Result<T>,
    ) -> jni::errors::Result<T> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
        vm.attach_current_thread(f)
    }

    fn foreground_class(
        env: &mut Env<'_>,
    ) -> jni::errors::Result<&'static Global<JClass<'static>>> {
        if let Some(class) = CLASS.get() {
            return Ok(class);
        }
        let ctx = ndk_context::android_context();
        let context = unsafe { JObject::from_raw(env, ctx.context().cast()) };
        let loader = env
            .call_method(
                &context,
                jni_str!("getClassLoader"),
                jni_sig!(() -> JClassLoader),
                &[],
            )?
            .l()?;
        let loader: JClassLoader = env.cast_local::<JClassLoader>(loader)?;
        let name = env.new_string("pro.kawai.app.KawaiForeground")?;
        let class: JClass = loader.load_class(env, name)?;
        let global = env.new_global_ref(class)?;
        Ok(CLASS.get_or_init(|| global))
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    pub fn acquire() {}
    pub fn release() {}
}
