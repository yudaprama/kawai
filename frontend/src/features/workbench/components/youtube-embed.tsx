/**
 * Canvas player for a YouTube Video Analysis run (PLAN-youtube-video-analysis).
 *
 * Pure halves + one component:
 * - [`timestampSeconds`] / [`linkifyTimestamps`] — the deliverable markdown's
 *   `mm:ss` tokens become links to the canonical watch URL (`?t=<n>s`), so
 *   the sanitizer sees plain https and nothing else changes.
 * - [`youtubeSeekSeconds`] — recognizes one of those links at click time.
 * - [`YoutubeEmbed`] — a click-to-load facade (thumbnail + play) that swaps
 *   to the privacy player (`youtube-nocookie.com`, `enablejsapi=1`) and
 *   answers `seek(seconds)` through the IFrame-API postMessage contract.
 *
 * Nothing here talks to the backend: the video id arrives on
 * `planStarted.videoId` and rides the persisted plan record for restores.
 */

import { useCallback, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";

import { Icon } from "@/components/shared/icon";

/** `mm:ss` / `h:mm:ss` → total seconds. `null` when the token is not a timestamp. */
export function timestampSeconds(ts: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(ts.trim());
  if (m == null) return null;
  const [, a, b, c] = m;
  return c != null ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
}

/** Canonical watch URL — every timestamp link resolves to this exact shape,
 *  which is what the click interceptor matches on. `seconds == null` omits
 *  the start time; an explicit 0 keeps `t=0s` so the click handler sees it. */
export function youtubeWatchUrl(videoId: string, seconds?: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return seconds != null ? `${base}&t=${seconds}s` : base;
}

const WATCH_HOSTS: Record<string, true> = {
  "youtube.com": true,
  "youtu.be": true,
  "m.youtube.com": true,
  "music.youtube.com": true,
};

/** Seconds carried by a watch/youtu.be link of THIS video (`?t=`/`&start=`),
 *  else `null` — the discriminator the deliverable's click handler uses to
 *  turn a navigation into an in-app seek. */
export function youtubeSeekSeconds(href: string, videoId: string): number | null {
  let url: URL;
  try {
    url = new URL(href, "https://www.youtube.com");
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (WATCH_HOSTS[host] !== true) return null;
  const id = host === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v");
  if (id !== videoId) return null;
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (raw == null) return null;
  const m = /^(\d+)s?$/.exec(raw);
  return m != null ? Number(m[1]) : null;
}

/** A bare `mm:ss`/`h:mm:ss` token that LEADS a line or a list item — the
 *  deliverable's Timestamps and Quotes sections (`0:00 — intro`,
 *  `- **1:23** — claim`). Mid-line numbers (ratios, scores) never match. */
const LEADING_TIMESTAMP = /^([ \t]*(?:[-*+]|\d+[.)])?[ \t]*)(\*{0,2})(\d{1,3}:[0-5]\d(?::[0-5]\d)?)(\2)(?=\s)/gm;

/** Rewrite those leading timestamps into watch links of `videoId`. Fenced
 *  code blocks are left alone — transcript excerpts live in code fences and
 *  their timestamps are data, not navigation. */
export function linkifyTimestamps(markdown: string, videoId: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // odd segments are the fences themselves
      return part.replace(LEADING_TIMESTAMP, (line, prefix, boldOpen, ts, boldClose) => {
        const seconds = timestampSeconds(ts);
        if (seconds == null) return line;
        return `${prefix}${boldOpen}[${ts}](${youtubeWatchUrl(videoId, seconds)})${boldClose}`;
      });
    })
    .join("");
}

/** The IFrame-API origin the player posts commands to. */
const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

export interface YoutubeEmbedHandle {
  /** Seek the player to `seconds`, activating the facade first if needed. */
  seek: (seconds: number) => void;
}

/** Click-to-load player: the thumbnail stays a plain image until the user
 *  asks for playback, so reading a brief without the video never loads
 *  YouTube's player JS (or its cookies). Offline, the facade degrades to a
 *  placeholder and "YouTube" hands off to the OS browser. */
export function YoutubeEmbed({
  videoId,
  title,
  ref,
}: {
  videoId: string;
  /** Poster/iframe accessible name — the run goal reads best here. */
  title?: string;
  ref?: Ref<YoutubeEmbedHandle>;
}) {
  const [active, setActive] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const activeRef = useRef(false);
  /** A seek that arrived before the iframe mounted — flushed on load. */
  const pendingSeekRef = useRef<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const postSeek = useCallback((seconds: number) => {
    const frame = frameRef.current;
    if (frame == null) return;
    // The widget handshake first — seekTo is dropped without it.
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), EMBED_ORIGIN);
    frame.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "seekTo", args: [seconds] }),
      EMBED_ORIGIN,
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      seek(seconds: number) {
        pendingSeekRef.current = seconds;
        if (activeRef.current) postSeek(seconds);
        else setActive(true); // the onLoad flush below applies the pending seek
      },
    }),
    [postSeek],
  );

  const activate = () => {
    activeRef.current = true;
    setActive(true);
  };

  const onFrameLoad = () => {
    const pending = pendingSeekRef.current;
    if (pending != null) {
      pendingSeekRef.current = null;
      postSeek(pending);
    }
  };

  const openExternal = () => {
    const url = youtubeWatchUrl(videoId);
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {});
    } else {
      window.open(url, "_blank", "noopener");
    }
  };

  return (
    <figure className="border-border/60 overflow-hidden rounded-lg border bg-black">
      <div className="relative aspect-video w-full">
        {active ? (
          <iframe
            ref={frameRef}
            src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1&enablejsapi=1`}
            title={title ?? `YouTube video ${videoId}`}
            onLoad={onFrameLoad}
            className="absolute inset-0 size-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            onClick={activate}
            aria-label={title ?? `Play YouTube video ${videoId}`}
            className="group absolute inset-0 size-full cursor-pointer"
          >
            {thumbFailed ? (
              <div className="bg-muted text-muted-foreground absolute inset-0 flex items-center justify-center font-mono text-xs">
                {videoId}
              </div>
            ) : (
              <img
                src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
                alt=""
                loading="lazy"
                onError={() => setThumbFailed(true)}
                className="absolute inset-0 size-full object-cover"
              />
            )}
            <span className="bg-background/70 text-foreground group-hover:bg-background absolute top-1/2 left-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-colors">
              <Icon name="play" className="size-5 translate-x-px" />
            </span>
            <span className="text-muted-foreground group-hover:text-foreground absolute right-2 bottom-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[0.625rem] text-white">
              Tap to play
            </span>
          </button>
        )}
      </div>
      <figcaption className="text-muted-foreground border-border/60 flex items-center justify-between gap-2 border-t px-3 py-1.5 font-mono text-[0.625rem]">
        <span className="min-w-0 truncate">{title ?? videoId}</span>
        <button
          type="button"
          onClick={openExternal}
          className="hit-44 hover:text-foreground inline-flex shrink-0 items-center gap-1"
          title="Open in the system browser"
        >
          <Icon name="external-link" className="size-3" />
          YouTube
        </button>
      </figcaption>
    </figure>
  );
}
