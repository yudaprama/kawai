import { type ReactNode, useState } from "react";
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
import { base64ToBytes, downloadBlob } from "@/lib/base64";

/**
 * The `kawai-file://` markdown token every deliverable viewer resolves — one
 * builder for all three media lanes so a copied token always has the same
 * shape (caption = the prompt excerpt, falling back to the file name).
 */
export function mediaToken(prompt: string, fileId: string, name: string): string {
  return `![${prompt.slice(0, 48) || name}](kawai-file://${fileId})`;
}

/**
 * A result caption is one line of a tile that can be 185px wide, and a
 * generated prompt is routinely 300+ characters (booru tag soup). Cut at a
 * word boundary so the tail stays readable instead of slicing a tag in half;
 * the full text stays on the caption's `title` and in the preview overlay.
 */
export function mediaExcerpt(text: string, limit = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The caption row under a result tile: prompt excerpt, then the run's detail
 * line (timestamp, dimensions, model). It sits BELOW the media box on purpose
 * — the prompt used to be an overlay strip inside the image, and a long one
 * grew that strip to a third of the tile and painted itself across the
 * artwork. The tile shows the art; the caption explains it.
 */
function ResultCaption({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5" title={label}>
      {/* `line-clamp-N` needs `display: -webkit-box` to clamp at all, and
          Tailwind emits `block`/`flex` AFTER it — pairing them silently
          disables the clamp. Keep display utilities off these spans. */}
      <span className="line-clamp-1 text-[0.75rem] text-foreground">{mediaExcerpt(label)}</span>
      {meta && <span className="line-clamp-1 text-[0.6875rem] text-muted-foreground">{meta}</span>}
    </div>
  );
}

/**
 * The card shell every generated-media result shares: a media box (the lane's
 * own markup — image, poster, `<audio>` player) with `ResultActions` pinned
 * inside it, plus the caption row underneath.
 *
 * `aspect` is the media box's own ratio (`"1024 / 1216"`). Left out, the box
 * takes the height its content needs — the music lane's player, and the image
 * lane's legacy entries without a dimension snapshot.
 */
export function ResultTile({
  aspect,
  children,
  label,
  meta,
}: {
  aspect?: string;
  children: ReactNode;
  label: string;
  meta?: string;
}) {
  return (
    <div className="group overflow-hidden rounded-[8px] border bg-secondary">
      <div className="relative overflow-hidden" style={aspect ? { aspectRatio: aspect } : undefined}>
        {children}
      </div>
      <ResultCaption label={label} meta={meta} />
    </div>
  );
}

/**
 * The action overlay every generated-media result card (image, video, music,
 * 3D) pins INSIDE its media box: copy the markdown token, download the stored
 * bytes, load the generating settings back into the form, or drop the entry
 * from the panel's results log. The prompt and the run's detail line live in
 * `ResultCaption`, below the artwork — this bar is buttons only, so it can sit
 * over the media without ever covering the subject.
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
  onRemove,
  onReuse,
  token,
}: {
  fileId: string;
  fileName: string;
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
      // Blob URL, not a base64 data: URL — a multi-MB video/3D result must
      // not double into the JS heap on a phone just to be saved.
      downloadBlob(new Blob([base64ToBytes(res.dataBase64)], { type: res.mime }), fileName);
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

      {/* Buttons only, right-aligned, revealed on hover AND keyboard focus.
          Hidden on touch as well now that the caption carries the prompt: the
          persistent ⋯ menu above already reaches all four actions by pointer
          and by keyboard, so an always-on strip would only sit on the art. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-0.5 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
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
