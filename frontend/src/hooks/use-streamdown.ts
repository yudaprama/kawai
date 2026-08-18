import { useMemo } from 'react'
import { cjk } from '@/lib/streamdown/plugins/cjk'
import { code } from '@/lib/streamdown/plugins/code'
import { math } from '@/lib/streamdown/plugins/math'
import { mermaid as mermaidPlugin } from '@/lib/streamdown/plugins/mermaid'
import type {
  MermaidOptions,
  StreamdownTranslations,
} from '@/lib/streamdown'
import { MermaidError } from '@/components/ai-elements/mermaid-error'

export const streamdownPlugins = {
  cjk,
  code,
  math,
  mermaid: mermaidPlugin,
}

const mermaidOptions: MermaidOptions = { errorComponent: MermaidError }

const defaultTranslations: StreamdownTranslations = {
  close: 'Close',
  copied: 'Copied!',
  copyCode: 'Copy code',
  copyLink: 'Copy link',
  copyTable: 'Copy table',
  copyTableAsCsv: 'Copy as CSV',
  copyTableAsMarkdown: 'Copy as Markdown',
  copyTableAsTsv: 'Copy as TSV',
  downloadDiagram: 'Download diagram',
  downloadDiagramAsMmd: 'Download as .mmd',
  downloadDiagramAsPng: 'Download as PNG',
  downloadDiagramAsSvg: 'Download as SVG',
  downloadFile: 'Download file',
  downloadImage: 'Download image',
  downloadTable: 'Download table',
  downloadTableAsCsv: 'Download as CSV',
  downloadTableAsMarkdown: 'Download as Markdown',
  exitFullscreen: 'Exit fullscreen',
  externalLinkWarning: 'This link will open in a new tab',
  imageNotAvailable: 'Image not available',
  mermaidFormatMmd: '.mmd',
  mermaidFormatPng: 'PNG',
  mermaidFormatSvg: 'SVG',
  openExternalLink: 'Open external link',
  openLink: 'Open link',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: 'View fullscreen',
}

export function useStreamdownTranslations(): StreamdownTranslations {
  return useMemo(() => defaultTranslations, [])
}

export function useStreamdownConfig() {
  const translations = useStreamdownTranslations()
  return useMemo(
    () => ({
      plugins: streamdownPlugins,
      translations,
      mermaid: mermaidOptions,
    }),
    [translations],
  )
}
