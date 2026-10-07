import { toast } from "sonner";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";

/**
 * The `kawai-file://` markdown token every deliverable viewer resolves — one
 * builder for all three media lanes so a copied token always has the same
 * shape (caption = the prompt excerpt, falling back to the file name).
 */
export function mediaToken(prompt: string, fileId: string, name: string): string {
  return `![${prompt.slice(0, 48) || name}](kawai-file://${fileId})`;
}

/**
 * The action bar shared by every generated-media result card (image, video,
 * music): copy the markdown token, download the stored bytes, load the
 * generating settings back into the form, or drop the entry from the panel's
 * results log.
 *
 * Revealed on hover AND keyboard focus, and always visible below `sm` where
 * hover does not exist. `downloadHref` is the stored file's `data:` URL —
 * omit it while the preview is still loading and the Download button drops out.
 */
export function ResultActions({
  downloadHref,
  downloadName,
  label,
  onRemove,
  onReuse,
  token,
}: {
  downloadHref?: string;
  downloadName: string;
  /** Prompt/name line shown left of the buttons. */
  label: string;
  onRemove: () => void;
  onReuse: () => void;
  token: string;
}) {
  const { t } = useI18n();
  const actionClass = "size-6 shrink-0 text-white hover:bg-white/20";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
      <span className="line-clamp-1 flex-1 text-[11px] text-white/90">{label}</span>
      <Button
        aria-label={t("generator.copyToken")}
        className={actionClass}
        onClick={() => {
          void navigator.clipboard.writeText(token);
          toast.success(t("generator.copied"));
        }}
        size="icon"
        title={t("generator.copyToken")}
        variant="ghost"
      >
        <Icon className="size-3.5" name="copy" />
      </Button>
      {downloadHref && (
        <Button asChild className={actionClass} size="icon" title={t("common.download")}>
          <a aria-label={t("common.download")} download={downloadName} href={downloadHref}>
            <Icon className="size-3.5" name="download" />
          </a>
        </Button>
      )}
      <Button
        aria-label={t("generator.reuseSettings")}
        className={actionClass}
        onClick={onReuse}
        size="icon"
        title={t("generator.reuseSettings")}
        variant="ghost"
      >
        <Icon className="size-3.5" name="rotate-ccw" />
      </Button>
      <Button
        aria-label={t("generator.removeResult")}
        className={actionClass}
        onClick={onRemove}
        size="icon"
        title={t("generator.removeResult")}
        variant="ghost"
      >
        <Icon className="size-3.5" name="trash-2" />
      </Button>
    </div>
  );
}
