import { useState } from "react";
import { toast } from "sonner";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText, type ReadFileResult } from "@/lib/api";

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
 * music, 3D): copy the markdown token, download the stored bytes, load the
 * generating settings back into the form, or drop the entry from the panel's
 * results log.
 *
 * The bar reveals on hover AND keyboard focus. Because a touch device has no
 * hover — and tapping a card opens the preview overlay, never this bar — the
 * four actions ALSO live in a persistent overflow menu pinned to the card's
 * top-right corner. That corner button is always visible, so every action is
 * reachable by pointer and by keyboard regardless of input mode.
 *
 * Download reads the ORIGINAL on click instead of taking a `data:` URL prop:
 * cards render a 512px thumbnail (or a poster), so handing them the bytes
 * would mean fetching every full file just to have a link ready nobody clicks.
 */
export function ResultActions({
  fileId,
  fileName,
  label,
  meta,
  onRemove,
  onReuse,
  token,
}: {
  fileId: string;
  fileName: string;
  /** Prompt/name line shown left of the buttons. */
  label: string;
  /** Secondary line under the prompt — timestamp, model, dimensions. */
  meta?: string;
  onRemove: () => void;
  onReuse: () => void;
  token: string;
}) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const actionClass = "size-6 shrink-0 text-white hover:bg-white/20";

  const copyToken = () => {
    void navigator.clipboard.writeText(token);
    toast.success(t("generator.copied"));
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await call<ReadFileResult>("office_read_file", { fileId });
      const anchor = document.createElement("a");
      anchor.href = `data:${res.mime};base64,${res.dataBase64}`;
      anchor.download = fileName;
      anchor.click();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      {/* Always-reachable overflow — the only path to these actions on a touch
          device, where the hover bar below never appears. */}
      <div className="absolute top-1.5 right-1.5 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t("generator.moreActions")}
              className="size-6 bg-black/55 text-white hover:bg-black/75"
              size="icon"
              title={t("generator.moreActions")}
              variant="ghost"
            >
              <Icon className="size-3.5" name="more-horizontal" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 rounded-[10px]">
            <DropdownMenuItem onSelect={copyToken}>
              <Icon className="size-4" name="copy" />
              {t("generator.copyToken")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={downloading} onSelect={() => void download()}>
              {downloading ? <Spinner className="size-4" /> : <Icon className="size-4" name="download" />}
              {t("common.download")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReuse}>
              <Icon className="size-4" name="rotate-ccw" />
              {t("generator.reuseSettings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={onRemove}>
              <Icon className="size-4" name="trash-2" />
              {t("generator.removeResult")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 block text-[11px] text-white/90">{label}</span>
          {meta && <span className="line-clamp-1 block text-[10px] text-white/60">{meta}</span>}
        </span>
        <Button
          aria-label={t("generator.copyToken")}
          className={actionClass}
          onClick={copyToken}
          size="icon"
          title={t("generator.copyToken")}
          variant="ghost"
        >
          <Icon className="size-3.5" name="copy" />
        </Button>
        <Button
          aria-label={t("common.download")}
          className={actionClass}
          disabled={downloading}
          onClick={() => void download()}
          size="icon"
          title={t("common.download")}
          variant="ghost"
        >
          {downloading ? <Spinner className="size-3" /> : <Icon className="size-3.5" name="download" />}
        </Button>
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
    </>
  );
}
