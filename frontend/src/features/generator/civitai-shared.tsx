import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Icon } from "@/components/shared/icon";
import { Spinner } from "@/components/ui/spinner";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/hooks/use-i18n";

/** Install the mount/unmount flip on an `alive` ref created by the CALLER:
 *  the `useRef(true)` binding must stay visible inside each component, or
 *  exhaustive-deps stops recognizing the value as a stable ref. Both
 *  Generator lanes (image + video) guard a long-lived in-flight job. */
export function useAliveEffect(aliveRef: { current: boolean }) {
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, [aliveRef]);
}

/** Vault-key presence for the civitai API: `null` while checking. */
export function useCivitaiKeyStatus(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    call<{ configured: boolean }>("civitai_api_key_status")
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);
  return configured;
}

/** Inline notices under the media island: key-missing body (`false`) or the
 *  checking spinner (`null`); nothing once configured. */
export function KeyStatusNotices({ configured }: { configured: boolean | null }) {
  const { t } = useI18n();
  if (configured === false) {
    return (
      <div className="bg-secondary text-muted-foreground flex items-start gap-2 rounded-[8px] border p-2.5 text-xs leading-relaxed">
        <Icon className="mt-0.5 size-4 shrink-0" name="info" />
        <span>{t("generator.keyMissingBody")}</span>
      </div>
    );
  }
  if (configured === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner className="size-4" /> {t("generator.checkingKey")}
      </div>
    );
  }
  return null;
}

/** One ecosystem option row shell for the picker dropdown: the button
 *  attributes + pick semantics are shared, the tile and labels differ per
 *  lane (image: cover tile + availability dimming; video: gradient avatar). */
export function EcoOptionButton({
  selected,
  onPick,
  title,
  style,
  children,
}: {
  selected: boolean;
  onPick: () => void;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-center gap-2 p-2.5 text-left transition-colors hover:bg-accent",
        selected && "bg-accent",
      )}
      onClick={onPick}
      role="option"
      style={style}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
