//! Per-tool-call app-token surcharge (PLAN-tool-usage-charging.md Fase 2).
//!
//! A priced tool charges a FLAT app-token fee per COMPLETED supervisor step,
//! on top of the LLM tokens its execution burned (those stay billable
//! KIND_LLM rows via the remote pool — the surcharge is tool margin, the same
//! relationship Civitai's 1.2× infrastructure markup has to its Buzz cost).
//! 1 app token = Rp 0,01 (worker `qris.ts` `TOKENS_PER_IDR = 100`).
//!
//! The table is the ONLY place a price lives. `None` = free — the default
//! for every tool not named here, and the reason local/on-device tools never
//! cost anything. Prices are PROPOSAL DEFAULTS (plan §10 Q2): the owner
//! adjusts the numbers, the mechanism does not change.

/// The flat app-token price of one completed call of `tool`, if priced.
pub fn tool_price(tool: &str) -> Option<u64> {
    match tool {
        // Arbitrary command execution through the external CLI bridge — the
        // heaviest per-call external surface in the catalog.
        "cli_run" => Some(1_000),
        // External search API spend (composio-backed discovery).
        "web_search" => Some(250),
        // `web_read` is deliberately UNPRICED for now: its tier-0 engine is
        // the on-device webview (free by design) and tier-1 is already
        // budgeted per-user/day (KAWAI_CF_PER_USER_DAILY) — a flat fee would
        // charge the free tier too. Price it only once the tool result
        // exposes which engine served the read.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The priced set is deliberate and small — everything else is free by
    /// default, and the free set is the reason the surcharge never fires on
    /// local/on-device tools.
    #[test]
    fn only_named_tools_are_priced() {
        assert_eq!(tool_price("cli_run"), Some(1_000));
        assert_eq!(tool_price("web_search"), Some(250));
        assert_eq!(tool_price("web_read"), None, "tier split unresolved — see module doc");
        assert_eq!(tool_price("data_query_nl"), None);
        assert_eq!(tool_price("office_list_files"), None);
        assert_eq!(tool_price("nonexistent_tool"), None);
    }
}
