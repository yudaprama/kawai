/** Single source of truth for file-extension sets used by knowledge ingestion and preview. */

export const OFFICE_EXTS: Set<string> = new Set(["docx", "xlsx", "pptx", "pdf"]);
export const IMAGE_EXTS: Set<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Accept list for the knowledge file picker — derived from OFFICE + IMAGE. */
export const ADD_FILE_ACCEPT = [...OFFICE_EXTS, ...IMAGE_EXTS].map((ext) => `.${ext}`);
