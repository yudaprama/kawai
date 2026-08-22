import { useCallback, useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";
import { Download, ExternalLink, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { errText, tauriOpenFile } from "@/lib/api";
import { fileKind, shikiLanguage, type FileKind } from "@/lib/file-types";
import { useFilePreview, type PreviewFile } from "@/lib/preview-file";
import { platform, runningInTauri } from "@/platform";

const FALLBACK_REASON: Partial<Record<FileKind, string>> = {
  "video-fallback": "This video format can't be previewed.",
  office: "Office documents can't be previewed — download to open them.",
  "video-native": "This video couldn't be loaded.",
  image: "This image couldn't be loaded.",
  pdf: "This PDF couldn't be loaded.",
  unknown: "Preview isn't available for this file type.",
};

/**
 * Dispatches to a renderer based on the file's kind (by extension). Images,
 * video and PDFs embed the resolved `data:` URL; text and markdown decode the
 * bytes. Anything the browser can't render natively shows a download fallback.
 */
export function FilePreview({ file }: { file: PreviewFile }) {
  const kind = fileKind(file.name);
  switch (kind) {
    case "image":
      return <ImagePreview file={file} />;
    case "video-native":
      return <VideoPreview file={file} />;
    case "pdf":
      return <PdfPreview file={file} />;
    case "markdown":
      return <TextPreview file={file} render="markdown" />;
    case "text":
      return <TextPreview file={file} render="code" />;
    default:
      return <FallbackPreview file={file} kind={kind} />;
  }
}

function ImagePreview({ file }: { file: PreviewFile }) {
  const [errored, setErrored] = useState(false);
  const { data, isLoading, error } = useFilePreview(file);
  if (errored || error) return <FallbackPreview file={file} kind="image" />;
  if (isLoading || !data?.dataUrl) return <PreviewLoading />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <img
        src={data.dataUrl}
        alt={file.name}
        onError={() => setErrored(true)}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

function VideoPreview({ file }: { file: PreviewFile }) {
  const [errored, setErrored] = useState(false);
  const { data, isLoading, error } = useFilePreview(file);
  if (errored || error) return <FallbackPreview file={file} kind="video-native" />;
  if (isLoading || !data?.dataUrl) return <PreviewLoading />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <video
        src={data.dataUrl}
        controls
        aria-label={file.name}
        onError={() => setErrored(true)}
        className="max-h-full max-w-full rounded-lg"
      >
        <track kind="captions" />
      </video>
    </div>
  );
}

function PdfPreview({ file }: { file: PreviewFile }) {
  // Desktop opens the file in the OS default viewer rather than embedding an
  // iframe (which can't render PDFs reliably under a restrictive sandbox).
  if (runningInTauri) return <DesktopFileOpen file={file} />;
  const { data, isLoading, error } = useFilePreview(file);
  if (isLoading || error || !data?.dataUrl) return <PreviewLoading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        src={data.dataUrl}
        title={file.name}
        sandbox="allow-scripts allow-same-origin allow-downloads"
        className="h-full min-h-0 w-full flex-1 rounded-lg border"
      />
    </div>
  );
}

/**
 * Desktop-only: resolves the file's on-disk path and opens it in the OS
 * default viewer via Tauri's `opener`. Shows a status panel with a
 * re-open / download fallback (the latter still needs the `data:` URL, so we
 * reuse the preview fetch).
 */
function DesktopFileOpen({ file }: { file: PreviewFile }) {
  const [error, setError] = useState<string | null>(null);
  const { data } = useFilePreview(file);

  const open = useCallback(async () => {
    setError(null);
    try {
      const path = await tauriOpenFile(file.id);
      await platform.openPath(path);
    } catch (e) {
      setError(errText(e));
    }
  }, [file.id]);

  useEffect(() => {
    open();
  }, [open]);

  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
        <ExternalLink className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {error ? "Couldn't open this file" : "Opened in your default app"}
        </p>
        <p className="text-xs">
          {error ?? `${file.name} should now be open in another window.`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={open}>
          <ExternalLink className="size-4" /> Open again
        </Button>
        {data?.dataUrl && (
          <Button asChild variant="secondary" size="sm">
            <a href={data.dataUrl} target="_blank" rel="noreferrer" download={file.name}>
              <Download className="size-4" /> Download
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function TextPreview({
  file,
  render,
}: {
  file: PreviewFile;
  render: "markdown" | "code";
}) {
  const { data, isLoading, error } = useFilePreview(file);

  if (isLoading) return <PreviewLoading />;

  if (error || !data?.text) {
    console.warn("[file-preview]", errText(error));
    return <FallbackPreview file={file} kind={render === "markdown" ? "markdown" : "text"} />;
  }

  const text = data.text;

  if (render === "markdown") {
    return (
      <div className="streamdown flex-1 overflow-auto p-4">
        <MessageResponse mode="static">{text}</MessageResponse>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <CodeBlock
        code={text}
        language={shikiLanguage(file.name) as BundledLanguage}
        showLineNumbers
        className="rounded-none border-0"
      />
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-sm">
      <Spinner className="size-4" /> Loading…
    </div>
  );
}

function FallbackPreview({
  file,
  kind,
}: {
  file: PreviewFile;
  kind: FileKind;
}) {
  const { data } = useFilePreview(file);
  const href = data?.dataUrl ?? "#";
  const reason =
    FALLBACK_REASON[kind] ?? FALLBACK_REASON.unknown ?? "Preview isn't available for this file type.";

  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
        <FileWarning className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">Can't preview this file</p>
        <p className="text-xs">{reason}</p>
      </div>
      <Button asChild variant="secondary" size="sm">
        <a href={href} target="_blank" rel="noreferrer" download={file.name}>
          <Download className="size-4" /> Download
        </a>
      </Button>
    </div>
  );
}
