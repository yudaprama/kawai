//! Per-tool-call app-token surcharge (PLAN-tool-usage-charging.md Fase 2).
//!
//! PRICING MODEL (owner decision 2026-10-19 — REVENUE, not cost-recovery):
//! the marginal cost of most calls is ~zero (free/flat APIs, on-device
//! compute), and LLM spend is already billed via the `gen_ai` pass-through —
//! so this fee is how tool usage itself makes money. Tiers, 1 token =
//! Rp 0,01:
//!
//!   1.000  external side effects (CLI execution, composio actions)
//!     500  money-moving order placements (confirmation-gated as well)
//!     250  generation / authoring (documents, decks, PDFs, invoices,
//!          diagrams, NL analytics, desk synthesis, web search)
//!     150  web page reads
//!     100  everything else — the affordable default (Rp 1/call)
//!    None  pure-local meta & own-data reads — the free set keeps the app
//!          fully navigable at zero balance
//!
//! The table below is the ONLY place a price lives. Never priced: tools that
//! never reach the dispatcher (internal subagents) — the choke point never
//! sees them, so their absence here is not a leak.

/// Pure-local introspection of the user's own data: free, always. This is
/// the set a zero-balance user can still run to see what the app holds.
const FREE: &[&str] = &[
    "office_list_files",
    "office_read_document",
    "office_document_info",
    "office_restore_backup",
    "pdf_extract_text",
    "pdf_search_text",
    "pdf_info",
    "pdf_merge",
    "pdf_split",
    "knowledge_search",
    "explain_step_result",
    "session_step_results",
    "graph_list",
    "graph_search",
    "codegraph_explore",
    "codegraph_status",
    "data_schema",
    "data_tables",
    "composio_list_tools",
];

/// The flat app-token price of one completed call of `tool`.
pub fn tool_price(tool: &str) -> Option<u64> {
    if FREE.contains(&tool) {
        return None;
    }

    match tool {
        // External side effects through first-party bridges.
        "cli_run" | "composio_execute" => Some(1_000),
        // Money-moving placements — also confirmation-gated upstream.
        "crypto_futures_place_stop_loss" | "crypto_futures_place_take_profit" => Some(500),
        // Generation / authoring — the product's output surface.
        "office_create_document"
        | "office_create_deck"
        | "office_edit_document"
        | "office_export_deck"
        | "pdf_create_from_markdown"
        | "pdf_replace_text"
        | "invoice_create"
        | "diagram_generate"
        | "data_query_nl"
        | "data_chart_nl"
        | "desk_data"
        | "desk_role"
        | "youtube_stage"
        | "web_search" => Some(250),
        // Web reads: now priced on BOTH tiers by owner decision — tier-0
        // (on-device webview) is free to serve but no longer free to use.
        "web_read" => Some(150),
        // Everything else — data reads, TA, syncs, bookkeeping — Rp 1/call.
        _ => Some(100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The free set is the only `None` — revenue model charges every
    /// dispatched call, with pure-local introspection exempted.
    #[test]
    fn only_the_free_set_is_free() {
        for tool in FREE {
            assert_eq!(tool_price(tool), None, "{tool} must stay free");
        }
        assert_eq!(tool_price("web_read"), Some(150));
        assert_eq!(tool_price("data_query"), Some(100));
        assert_eq!(tool_price("binance_futures_risk_audit"), Some(100));
        assert_eq!(tool_price("nonexistent_tool"), Some(100));
    }

    /// The tier boundaries an owner price change must keep deliberate:
    /// side effects > placements > generation > web reads > default.
    #[test]
    fn tiers_are_distinct_and_ordered() {
        assert_eq!(tool_price("cli_run"), Some(1_000));
        assert_eq!(tool_price("composio_execute"), Some(1_000));
        assert_eq!(tool_price("crypto_futures_place_stop_loss"), Some(500));
        assert_eq!(tool_price("crypto_futures_place_take_profit"), Some(500));
        for tool in [
            "office_create_document",
            "office_create_deck",
            "pdf_create_from_markdown",
            "invoice_create",
            "diagram_generate",
            "data_query_nl",
            "desk_role",
            "web_search",
        ] {
            assert_eq!(tool_price(tool), Some(250), "{tool}");
        }
        let prices: Vec<u64> = [
            tool_price("cli_run"),
            tool_price("crypto_futures_place_stop_loss"),
            tool_price("office_create_document"),
            tool_price("web_read"),
            tool_price("data_query"),
        ]
        .into_iter()
        .flatten()
        .collect();
        let mut sorted = prices.clone();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(prices, sorted, "tiers must descend: 1000/500/250/150/100");
    }
}
