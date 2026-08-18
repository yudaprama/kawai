import { useContext } from "react";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useMermaidPlugin } from "../plugin-context";
import type { MermaidConfig } from "../plugin-types";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import { save } from "../utils";
import { serializeSvgForDownload, svgToPngBlob, generateMermaidChartId } from "./utils";
import { Dropdown, type DropdownItem } from "../common";

interface MermaidDownloadDropdownProps {
  chart: string;
  children?: React.ReactNode;
  className?: string;
  config?: MermaidConfig;
  onDownload?: (format: "mmd" | "png" | "svg") => void;
  onError?: (error: Error) => void;
}

export const MermaidDownloadDropdown = ({
  chart,
  children,
  className,
  onDownload,
  config,
  onError,
}: MermaidDownloadDropdownProps) => {
  const cn = useCn();
  const { isAnimating } = useContext(StreamdownContext);
  const icons = useIcons();
  const mermaidPlugin = useMermaidPlugin();
  const t = useTranslations();

  const downloadMermaid = async (format: "mmd" | "png" | "svg") => {
    try {
      if (format === "mmd") {
        const filename = "diagram.mmd";
        const mimeType = "text/plain";
        save(filename, chart, mimeType);
        onDownload?.(format);
        return;
      }

      if (!mermaidPlugin) {
        onError?.(new Error("Mermaid plugin not available"));
        return;
      }

      const mermaid = mermaidPlugin.getMermaid(config);

      const uniqueId = generateMermaidChartId(chart);

      const { svg } = await mermaid.render(uniqueId, chart);

      if (!svg) {
        onError?.(
          new Error("SVG not found. Please wait for the diagram to render.")
        );
        return;
      }

      const serializedSvg = serializeSvgForDownload(svg);

      if (format === "svg") {
        const filename = "diagram.svg";
        const mimeType = "image/svg+xml";
        save(filename, serializedSvg, mimeType);
        onDownload?.(format);
        return;
      }

      if (format === "png") {
        const blob = await svgToPngBlob(serializedSvg);
        save("diagram.png", blob, "image/png");
        onDownload?.(format);
        return;
      }
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const items: DropdownItem[] = [
    {
      label: t.mermaidFormatSvg,
      onClick: () => downloadMermaid("svg"),
      title: t.downloadDiagramAsSvg,
    },
    {
      label: t.mermaidFormatPng,
      onClick: () => downloadMermaid("png"),
      title: t.downloadDiagramAsPng,
    },
    {
      label: t.mermaidFormatMmd,
      onClick: () => downloadMermaid("mmd"),
      title: t.downloadDiagramAsMmd,
    },
  ];

  return (
    <Dropdown
      className={cn(className)}
      items={items}
      triggerTitle={t.downloadDiagram}
      triggerAriaLabel={t.downloadDiagram}
      disabled={isAnimating}
    >
      {children ?? <icons.DownloadIcon size={14} />}
    </Dropdown>
  );
};