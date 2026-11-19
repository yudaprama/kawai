import { useEffect, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { call, errText } from "@/lib/api";
import { streamOperation, type StreamControl } from "@/lib/stream";
import { getLocale, translate } from "@/lib/i18n";
import { logWarn } from "@/lib/logger";
import { platform, runningInTauri } from "@/platform";

/** Mirror of `logic::update::UpdateInfo` (server-set `channel`). */
interface AndroidUpdateInfo {
  version: string;
  notes?: string | null;
  pub_date?: string | null;
  url: string;
  sha256: string;
  size?: number | null;
  channel: "apk" | "play";
}

/** Mirror of `logic::update::UpdateEvent` — terminals: finished | error. */
type AndroidUpdateEvent =
  | { type: "progress"; received: number; total: number }
  | { type: "finished"; path: string }
  | { type: "error"; message: string };

/**
 * Auto-update check, once per launch. Silent on every failure — offline, a
 * missing manifest, or a bad signature must never nag. When an update exists,
 * a persistent toast offers the install; installing streams a progress toast.
 *
 * Desktop: the official tauri-plugin-updater over the GitHub release static
 * `latest.json` — download + relaunch into the new bundle.
 *
 * Android: the in-app updater (`logic::update` + `update_installer`) over the
 * same release's `latest-android.json`. The `apk` channel (QRIS/sideload
 * build) downloads the sha256-verified APK and hands it to the system
 * installer; the `play` channel (`iap` build) opens the store listing — Play
 * forbids self-updating APKs, and that build ships without the install
 * permission at all. tauri-plugin-updater has no mobile backend, but the
 * Android build compiles the `desktop` feature (so the plugin IS registered
 * there) — without the target gate every phone launch would run a doomed
 * check and could surface an install toast that can never install.
 */
export function useUpdater() {
  // `started` survives effect re-runs (strict-mode double-invoke) so the
  // check is scheduled exactly once per process.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !runningInTauri || import.meta.env.DEV) return;
    if (platform.target === "desktop") {
      started.current = true;
      schedule(desktopCheck);
    } else if (platform.target === "mobile" && /Android/i.test(navigator.userAgent)) {
      started.current = true;
      schedule(androidCheck);
    }
  }, []);
}

function schedule(run: () => void) {
  // Boot network traffic (auth bootstrap, session restore) goes first.
  const timer = setTimeout(run, 5000);
  return () => clearTimeout(timer);
}

async function desktopCheck() {
  try {
    const update = await check();
    if (update) promptInstall(update);
  } catch (err) {
    logWarn("[updater] check failed:", err);
  }
}

function promptInstall(update: Update) {
  toast(translate(getLocale(), "updater.available", { version: update.version }), {
    duration: Infinity,
    action: {
      label: translate(getLocale(), "updater.install"),
      onClick: () => void install(update),
    },
  });
}

async function install(update: Update) {
  const id = toast.loading(translate(getLocale(), "updater.downloading", { percent: 0 }));
  let received = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total > 0) {
          toast.loading(
            translate(getLocale(), "updater.downloading", {
              percent: Math.min(99, Math.round((received / total) * 100)),
            }),
            { id },
          );
        }
      }
    });
    toast.dismiss(id);
    await relaunch();
  } catch (err) {
    toast.dismiss(id);
    logWarn("[updater] install failed:", err);
  }
}

async function androidCheck() {
  let info: AndroidUpdateInfo | null = null;
  try {
    info = await call<AndroidUpdateInfo | null>("update_check");
  } catch (err) {
    logWarn("[updater] check failed:", errText(err));
    return;
  }
  if (!info) return;
  toast(translate(getLocale(), "updater.available", { version: info.version }), {
    duration: Infinity,
    action: {
      label: translate(getLocale(), info.channel === "play" ? "updater.openStore" : "updater.install"),
      onClick: () => {
        if (info && info.channel === "play") void openStore();
        else if (info) void downloadAndInstall();
      },
    },
  });
}

async function openStore() {
  try {
    await call<string>("update_open_store");
    // The market:// intent fired on the backend — the store app takes over.
  } catch (err) {
    logWarn("[updater] store open failed:", errText(err));
    toast.error(translate(getLocale(), "common.error"));
  }
}

function downloadAndInstall(): StreamControl {
  const id = toast.loading(translate(getLocale(), "updater.downloading", { percent: 0 }));
  return streamOperation<AndroidUpdateEvent>("update_download_and_install", undefined, {
    onEvent: (event) => {
      if (event.type === "progress" && event.total > 0) {
        toast.loading(
          translate(getLocale(), "updater.downloading", {
            percent: Math.min(99, Math.round((event.received / event.total) * 100)),
          }),
          { id },
        );
      } else if (event.type === "finished") {
        // The backend handed the APK to the system installer — Android
        // takes over from here (the app is backgrounded).
        toast.dismiss(id);
        toast.success(translate(getLocale(), "updater.installing"));
      } else if (event.type === "error") {
        toast.dismiss(id);
        if (event.message.includes("install_permission_required")) {
          // The backend already opened the per-app "install unknown apps"
          // settings page — the user taps Update again after granting.
          toast(translate(getLocale(), "updater.installPermission"), { duration: Infinity });
          return;
        }
        logWarn("[updater] update failed:", event.message);
        toast.error(event.message);
      }
    },
    onError: () => {
      toast.dismiss(id);
      toast.error(translate(getLocale(), "common.error"));
    },
    // `finished | error` are the default terminals; done only cleans up.
    onDone: () => toast.dismiss(id),
  });
}
