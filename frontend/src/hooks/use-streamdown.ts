import { useEffect, useMemo, useState } from "react";
import { MermaidError } from "@/components/ai-elements/mermaid-error";
import { useI18n } from "@/hooks/use-i18n";
import type { MermaidOptions, StreamdownProps, StreamdownTranslations } from "@/lib/streamdown";

// The plugin modules import the esm.sh-resolved markdown pipeline — the same
// CDN graph LazyStreamdown loads behind a dynamic import. They are imported
// dynamically here too: a static import would put the CDN modules back into
// the entry chunk, where a CDN failure bricks the whole app at boot
// (see components/shared/lazy-streamdown.tsx).
type StreamdownPlugins = NonNullable<StreamdownProps["plugins"]>;

let pluginsPromise: Promise<StreamdownPlugins> | null = null;
function loadStreamdownPlugins(): Promise<StreamdownPlugins> {
  pluginsPromise ??= Promise.all([
    import("@/lib/streamdown/plugins/cjk"),
    import("@/lib/streamdown/plugins/code"),
    import("@/lib/streamdown/plugins/math"),
    import("@/lib/streamdown/plugins/mermaid"),
  ]).then(([cjk, code, math, mermaid]) => ({
    cjk: cjk.cjk,
    code: code.code,
    math: math.math,
    mermaid: mermaid.mermaid,
  }));
  return pluginsPromise;
}

const mermaidOptions: MermaidOptions = { errorComponent: MermaidError };

const defaultTranslations: StreamdownTranslations = {
  close: "Close",
  copied: "Copied!",
  copyCode: "Copy code",
  copyLink: "Copy link",
  copyTable: "Copy table",
  copyTableAsCsv: "Copy as CSV",
  copyTableAsMarkdown: "Copy as Markdown",
  copyTableAsTsv: "Copy as TSV",
  downloadDiagram: "Download diagram",
  downloadDiagramAsMmd: "Download as .mmd",
  downloadDiagramAsPng: "Download as PNG",
  downloadDiagramAsSvg: "Download as SVG",
  downloadFile: "Download file",
  downloadImage: "Download image",
  downloadTable: "Download table",
  downloadTableAsCsv: "Download as CSV",
  downloadTableAsMarkdown: "Download as Markdown",
  exitFullscreen: "Exit fullscreen",
  externalLinkWarning: "This link will open in a new tab",
  imageNotAvailable: "Image not available",
  mermaidFormatMmd: ".mmd",
  mermaidFormatPng: "PNG",
  mermaidFormatSvg: "SVG",
  openExternalLink: "Open external link",
  openLink: "Open link",
  tableFormatCsv: "CSV",
  tableFormatMarkdown: "Markdown",
  tableFormatTsv: "TSV",
  viewFullscreen: "View fullscreen",
};

export function useStreamdownTranslations(): StreamdownTranslations {
  const { t } = useI18n();
  return useMemo(() => ({ ...defaultTranslations, close: t("common.close"), copied: t("common.copied") }), [t]);
}

export function useStreamdownConfig() {
  const translations = useStreamdownTranslations();
  const [plugins, setPlugins] = useState<StreamdownPlugins | null>(null);
  useEffect(() => {
    let disposed = false;
    void loadStreamdownPlugins().then((loaded) => {
      if (!disposed) setPlugins(loaded);
    });
    return () => {
      disposed = true;
    };
  }, []);
  return useMemo(
    () => ({
      mermaid: mermaidOptions,
      plugins: plugins ?? undefined,
      /** false until the CDN plugin modules resolve — renderers gate on this. */
      ready: plugins != null,
      translations,
    }),
    [plugins, translations],
  );
}
