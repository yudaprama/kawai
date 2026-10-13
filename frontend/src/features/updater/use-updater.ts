import { useEffect, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { getLocale, translate } from "@/lib/i18n";
import { logWarn } from "@/lib/logger";
import { runningInTauri } from "@/platform";

/**
 * Auto-update check, once per launch (updater endpoint: the GitHub release
 * static `latest.json`). Silent on every failure — offline, endpoint 404,
 * or a bad signature must never nag. When an update exists, a persistent
 * toast offers download+install; installing streams a progress toast and
 * relaunches into the new bundle.
 */
export function useUpdater() {
  // `started` survives effect re-runs (strict-mode double-invoke) so the
  // check is scheduled exactly once per process.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !runningInTauri || import.meta.env.DEV) return;
    started.current = true;
    // Boot network traffic (auth bootstrap, session restore) goes first.
    const timer = setTimeout(() => {
      void check()
        .then((update) => {
          if (update) promptInstall(update);
        })
        .catch((err) => logWarn("[updater] check failed:", err));
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
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
