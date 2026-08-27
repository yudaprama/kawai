#[allow(dead_code)]

// ── tool budget ─────────────────────────────────────────────────────────────
#[cfg(feature = "litert")]
pub const MAX_TOOL_CALLS: usize = 8;
#[cfg(feature = "litert")]
pub const TOOL_RESULT_UI_CHARS: usize = 500;
pub const TOOL_RESULT_DATA_CHARS: usize = 32_000;
#[cfg(feature = "litert")]
pub const TOOL_RESULT_MODEL_CHARS: usize = 4000;
#[cfg(feature = "litert")]
pub const TOOL_RESULT_MATERIALS_CHARS: usize = 32_000;
#[cfg(feature = "litert")]
pub const TOOL_RESULT_ENTRY_MAX_CHARS: usize = 96_000;

// ── transcript ──────────────────────────────────────────────────────────────
#[cfg(feature = "litert")]
pub const TRANSCRIPT_MSG_CHARS: usize = 2000;
#[cfg(feature = "litert")]
pub const TRANSCRIPT_LAST_MSG_CHARS: usize = 6000;
#[cfg(feature = "litert")]
pub const TRANSCRIPT_BUDGET_CHARS: usize = 6000;
#[cfg(feature = "litert")]
pub const TRANSCRIPT_BUDGET_RETRY_CHARS: usize = 3000;

// ── subagent / cloud ────────────────────────────────────────────────────────
#[cfg(feature = "litert")]
pub const MAX_SUBAGENT_CALLS: usize = 1;
#[cfg(feature = "litert")]
pub const DEEP_WRITE_TOOL: &str = "deep_write";
#[cfg(feature = "litert")]
pub const DRAFT_DOCUMENT_TOOL: &str = "draft_document";
#[cfg(feature = "litert")]
pub const ARTIFACT_RECALL_TOOL: &str = "artifact_recall";
#[cfg(all(feature = "litert", feature = "analytics"))]
pub const DATA_IMPORT_TOOL: &str = "data_import";
#[cfg(feature = "litert")]
pub const REMOTE_TIMEOUT_SECS: u64 = 600;
#[cfg(feature = "litert")]
pub const DRAFT_JSON_MAX_CHARS: usize = 120_000;
#[cfg(feature = "litert")]
pub const SUBAGENT_THINKING_MAX_CHARS: usize = 16_000;
#[cfg(feature = "litert")]
pub const ARTIFACT_EXCERPT_CHARS: usize = 3_200;
#[cfg(feature = "litert")]
pub const ARTIFACT_PAGE_CHARS: usize = 3_600;
#[cfg(feature = "litert")]
pub const CLOUD_CLOSE_MIN_CHARS: usize = 6_000;
#[cfg(feature = "litert")]
pub const MATERIALS_NOTE_RESERVE: usize = 600;
#[cfg(feature = "litert")]
pub const MATERIALS_NOTE_MARKER: &str = "[MATERIALS NOTE:";
#[cfg(feature = "litert")]
pub const STAGING_MAX_REQUESTS: usize = 6;
