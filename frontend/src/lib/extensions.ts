/** Single source of truth for file-extension sets used by knowledge ingestion and preview. */

export const OFFICE_EXTS: Set<string> = new Set(["docx", "xlsx", "pptx", "pdf"]);
export const IMAGE_EXTS: Set<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
/** Tabular data files accepted for import — queried structurally by the Analytics agent. */
export const DATA_EXTS: Set<string> = new Set(["csv", "tsv", "parquet"]);
/**
 * Every extension the Analytics agent queries structurally (mirror of the
 * backend's `is_tabular_ext`) — these are never prose-indexed by RAG.
 */
export const TABULAR_EXTS: Set<string> = new Set(["csv", "tsv", "parquet", "xlsx", "xlsm"]);

/** Accept list for the knowledge file picker — derived from OFFICE + IMAGE + DATA. */
export const ADD_FILE_ACCEPT = [...OFFICE_EXTS, ...IMAGE_EXTS, ...DATA_EXTS].map((ext) => `.${ext}`);

/** Whether an extension (lowercase, no dot) is queried structurally instead of prose-indexed. */
export function isTabularExt(ext: string): boolean {
  return TABULAR_EXTS.has(ext.toLowerCase());
}
