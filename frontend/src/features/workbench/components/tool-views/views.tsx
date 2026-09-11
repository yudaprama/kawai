// LEGACY SHIM — views.tsx has been split into family files.
// This barrel re-exports everything so old import paths keep working.
// New code should import directly from the family file (atoms, file-views, etc.)
// or from index.tsx (renderStepReport). Will be removed after callers migrate.

export * from "./atoms";
export * from "./markdown-views";
export * from "./file-views";
export * from "./memory-views";
export * from "./finance-views";
export * from "./news-views";
export * from "./generic-views";
export * from "./bespoke-views";
