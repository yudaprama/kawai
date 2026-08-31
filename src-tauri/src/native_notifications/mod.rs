//! Native OS notification commands.
//!
//! Provides three Tauri commands for reliable OS-level notifications:
//!
//! * `notification_permission_state` — read the current authorization status
//! * `notification_permission_request` — trigger the OS permission prompt
//! * `show_native_notification` — fire a native notification banner
//!
//! On macOS we drive `UNUserNotificationCenter` directly via `objc2` for
//! reliable permission checks and delivery confirmation. On Linux/Windows
//! we delegate to `tauri-plugin-notification`.
//!
//! The bundled plugin's `permission_state()` is hardcoded to `Granted`, so
//! a frontend permission gate built on it cannot detect when macOS has
//! notifications disabled for the bundle. This module avoids that trap.

use tauri::AppHandle;

#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

/// Tauri command: report the current OS notification authorization state.
///
/// Returns one of: `granted`, `denied`, `not_determined`, `provisional`,
/// `ephemeral`, `unknown`. Non-macOS targets always return `granted`.
#[tauri::command]
pub fn notification_permission_state() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::permission_state()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("granted".to_string())
    }
}

/// Tauri command: trigger the OS-level permission prompt and return the
/// resulting authorization state (`granted` or `denied` on macOS).
#[tauri::command]
pub fn notification_permission_request() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("granted".to_string())
    }
}

/// Tauri command: fire a native OS notification.
///
/// On macOS, fails fast if notification permission is not actually granted
/// and waits for the `addNotificationRequest:withCompletionHandler:`
/// completion before returning.
#[tauri::command]
pub fn show_native_notification(
    app: AppHandle,
    title: String,
    body: String,
    tag: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[notify] show_native_notification title_chars={} body_chars={} tag={:?}",
        title.len(),
        body.len(),
        tag
    );

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos::show(title, body, tag)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut builder = app.notification().builder().title(&title);
        if !body.is_empty() {
            builder = builder.body(&body);
        }
        builder
            .show()
            .map_err(|e| format!("notification show failed: {e}"))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::Path;
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotificationRequest, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter,
    };

    /// Read authorization status synchronously by blocking on
    /// `getNotificationSettingsWithCompletionHandler:`.
    pub(super) fn permission_state() -> Result<String, String> {
        ensure_bundled_app()?;
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel::<String>();
        let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref().authorizationStatus() };
            let _ = tx.send(status_to_str(status).to_string());
        });
        center.getNotificationSettingsWithCompletionHandler(&completion);
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "timed out waiting for macOS notification settings".to_string())
    }

    /// Trigger the OS prompt for notification authorization.
    pub(super) fn request_permission() -> Result<String, String> {
        ensure_bundled_app()?;
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel::<bool>();
        let options = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Badge
            | UNAuthorizationOptions::Sound;
        let completion = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        center.requestAuthorizationWithOptions_completionHandler(options, &completion);
        let granted = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out waiting for macOS permission prompt result".to_string())?;
        Ok(if granted { "granted" } else { "denied" }.to_string())
    }

    /// Build a `UNNotificationRequest` and submit it. Re-checks
    /// authorization first so we never call `addNotificationRequest:` on
    /// a denied/not-determined state.
    pub(super) fn show(title: String, body: String, tag: Option<String>) -> Result<(), String> {
        ensure_bundled_app()?;
        let state = permission_state()?;
        if !is_granted(&state) {
            eprintln!("[notify] show aborted: permission state={state}");
            return Err(format!(
                "notification permission not granted (state: {state})"
            ));
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        if !body.is_empty() {
            content.setBody(&NSString::from_str(&body));
        }
        let default_sound = UNNotificationSound::defaultSound();
        content.setSound(Some(&default_sound));

        let identifier_str = tag.unwrap_or_else(|| {
            format!(
                "kawai.notify.{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            )
        });
        let identifier = NSString::from_str(&identifier_str);

        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );

        let (tx, rx) = mpsc::channel::<Option<String>>();
        let completion = RcBlock::new(move |error: *mut NSError| {
            if error.is_null() {
                let _ = tx.send(None);
                return;
            }
            let message = unsafe { (*error).localizedDescription().to_string() };
            let _ = tx.send(Some(message));
        });

        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));

        match rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "timed out waiting for macOS notification dispatch".to_string())?
        {
            None => {
                eprintln!("[notify] macos add succeeded id={identifier_str}");
                Ok(())
            }
            Some(err) => {
                eprintln!("[notify] macos add failed: {err}");
                Err(format!("notification show failed: {err}"))
            }
        }
    }

    fn is_granted(state: &str) -> bool {
        matches!(state, "granted" | "provisional" | "ephemeral")
    }

    /// `UNUserNotificationCenter` aborts an unbundled macOS process rather
    /// than returning an error. `cargo tauri dev` runs exactly that shape.
    fn ensure_bundled_app() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("could not determine macOS executable path: {error}"))?;
        if is_bundled_app_executable(&executable) {
            Ok(())
        } else {
            Err(
                "native notifications are unavailable in an unbundled macOS dev process"
                    .to_string(),
            )
        }
    }

    fn is_bundled_app_executable(executable: &Path) -> bool {
        executable.parent().is_some_and(|macos_dir| {
            macos_dir.file_name().is_some_and(|name| name == "MacOS")
                && macos_dir.parent().is_some_and(|contents_dir| {
                    contents_dir
                        .file_name()
                        .is_some_and(|name| name == "Contents")
                        && contents_dir.parent().is_some_and(|bundle_dir| {
                            bundle_dir
                                .extension()
                                .is_some_and(|extension| extension == "app")
                        })
                })
        })
    }

    fn status_to_str(status: UNAuthorizationStatus) -> &'static str {
        if status == UNAuthorizationStatus::Authorized {
            "granted"
        } else if status == UNAuthorizationStatus::Denied {
            "denied"
        } else if status == UNAuthorizationStatus::NotDetermined {
            "not_determined"
        } else if status == UNAuthorizationStatus::Provisional {
            "provisional"
        } else if status == UNAuthorizationStatus::Ephemeral {
            "ephemeral"
        } else {
            "unknown"
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn is_granted_treats_authorized_variants_as_granted() {
            assert!(is_granted("granted"));
            assert!(is_granted("provisional"));
            assert!(is_granted("ephemeral"));
        }

        #[test]
        fn is_granted_rejects_unauthorized_states() {
            assert!(!is_granted("denied"));
            assert!(!is_granted("not_determined"));
            assert!(!is_granted("unknown"));
            assert!(!is_granted(""));
        }

        #[test]
        fn bundled_app_layout_is_accepted() {
            assert!(is_bundled_app_executable(Path::new(
                "/Applications/kawai.app/Contents/MacOS/kawai"
            )));
        }

        #[test]
        fn unbundled_executable_is_rejected() {
            assert!(!is_bundled_app_executable(Path::new(
                "/tmp/kawai/target/debug/kawai"
            )));
        }
    }
}
