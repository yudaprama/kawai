//! Auto-routing adapter: resolves an agent id when the user has not selected one.
//!
//! When a chat turn arrives with `agent_id = "auto"` or empty, this module
//! calls the rule-based router to pick the best candidate from the catalog.
//! Existing sessions keep their original agent id (frontends send the
//! session's `agentId` so the resolver is not invoked for them).
//!
//! # Feature gating
//!
//! This module is only compiled when the `router` feature is enabled.
//! In production builds it is chained into `litert` in `Cargo.toml`,
//! so every `cargo check --features litert` includes it.
//!
//! # Responsibilities
//!
//! * Build [`RoutingCandidate`]s from [`crate::agent_registry::builtin()`]
//!   (source of truth for which agents exist and are enabled).
//! * Validate an explicitly requested agent id against the registry.
//! * Route ambiguous/empty ids via [`kawai_router::IntentRouter::route`].
//! * Log routing decisions for debugging.

use crate::agent_registry::{ANALYTICS_AGENT_ID, BINANCE_AGENT_ID, OFFICE_AGENT_ID, PRESENTATION_AGENT_ID};
use kawai_router::{IntentRouter, RouteDecision, RouteSource, RoutingCandidate};

/// Sentinel value indicating the backend should pick the agent.
pub const AUTO_AGENT_ID: &str = "auto";

/// Returns `true` when the request asks the backend to auto-select an agent.
pub fn is_auto(agent_id: &str) -> bool {
    let trimmed = agent_id.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case(AUTO_AGENT_ID)
}

// ── Per-agent routing hints ─────────────────────────────────────────────────

/// Keyword hints per catalog id, gated to match feature availability.
/// These are **routing-specific** metadata — not part of the agent's public
/// UI description.  When a new agent is added to the registry, its hints
/// must be added here to enable automatic selection.
fn hints_for(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        OFFICE_AGENT_ID => &[
            "pdf", "docx", "dokumen", "document", "merge", "gabung", "gabungkan",
            "split", "pisah", "convert", "konversi", "edit", "file", "folder",
        ],
        #[cfg(feature = "office")]
        PRESENTATION_AGENT_ID => &[
            "slide", "slides", "deck", "powerpoint", "pptx", "presentasi",
            "presentation", "pitch deck", "slide deck",
        ],
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => &[
            "bitcoin", "btc", "ethereum", "eth", "crypto", "kripto",
            "coin", "token", "trading", "exchange", "order book", "candle",
            "harga bitcoin", "harga crypto", "market", "altcoin", "dogecoin", "solana",
        ],
        #[cfg(feature = "analytics")]
        ANALYTICS_AGENT_ID => &[
            "csv", "excel", "xlsx", "data", "analisa", "analysis", "chart",
            "grafik", "trend", "forecast", "roi", "revenue", "sql",
            "statistik", "aggregate", "pivot", "kolom", "laporan data",
        ],
        _ => &[],
    }
}

// ── Candidate builder ───────────────────────────────────────────────────────

/// Build [`RoutingCandidate`]s from the composition root's agent catalog.
///
/// Only agents with `tools = true` (i.e. agents that can actually run domain
/// tools rather than being persona-only placeholders) are included.
pub fn routing_candidates() -> Vec<RoutingCandidate> {
    crate::agent_registry::builtin()
        .list()
        .into_iter()
        .filter(|info| info.tools)
        .map(|info| RoutingCandidate {
            agent_id: info.id.clone(),
            name: info.name.clone(),
            description: info.description.clone(),
            hints: hints_for(&info.id).iter().map(|s| (*s).to_string()).collect(),
        })
        .collect()
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Resolve the effective agent id for a chat turn.
///
/// * Explicit, valid, non-auto id → passed through unchanged.
/// * Auto/empty/unavailable id → rule-based route via [`IntentRouter`].
pub fn resolve_start_agent(requested: &str, query: &str) -> String {
    let trimmed = requested.trim();
    if !is_auto(trimmed) {
        // Explicit id — validate against the registry.
        if crate::agent_registry::builtin().resolve(trimmed).is_some() {
            return trimmed.to_string();
        }
        eprintln!(
            "[routing] requested agent '{trimmed}' not found in registry — falling back to auto-route"
        );
    }

    let candidates = routing_candidates();
    let router = IntentRouter::new(candidates, OFFICE_AGENT_ID.to_string());
    let decision = router.route(query);
    log_decision(query, &decision);
    decision.agent_id
}

/// A synchronous wrapper that returns the full [`RouteDecision`] instead of
/// just the agent id.  Useful for UI display ("Using: Analytics") and
/// telemetry.
pub fn resolve_with_decision(requested: &str, query: &str) -> RouteDecision {
    let trimmed = requested.trim();
    if !is_auto(trimmed) {
        if crate::agent_registry::builtin().resolve(trimmed).is_some() {
            return RouteDecision {
                agent_id: trimmed.to_string(),
                confidence: 1.0,
                source: RouteSource::Rule,
                matched: vec![],
            };
        }
        eprintln!(
            "[routing] requested agent '{trimmed}' not found — falling back to auto-route"
        );
    }

    let candidates = routing_candidates();
    let router = IntentRouter::new(candidates, OFFICE_AGENT_ID.to_string());
    let decision = router.route(query);
    log_decision(query, &decision);
    decision
}

/// Pretty-print the decision to stderr for debugging.
fn log_decision(query: &str, decision: &RouteDecision) {
    let query_preview: String = query.chars().take(60).collect();
    let hints_display = if decision.matched.is_empty() {
        "(fallback)".to_string()
    } else {
        decision.matched.join(", ")
    };
    eprintln!(
        "[routing] \"{}...\" → {} | source={:?} conf={:.2} hints=[{}]",
        query_preview, decision.agent_id, decision.source, decision.confidence, hints_display
    );
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_auto_recognizes_sentinels() {
        assert!(is_auto(""));
        assert!(is_auto("  "));
        assert!(is_auto("auto"));
        assert!(is_auto("Auto"));
        assert!(is_auto("AUTO"));
        assert!(!is_auto("builtin.office"));
        assert!(!is_auto("builtin.binance"));
    }

    #[test]
    fn routing_candidates_filters_by_feature_availability() {
        let candidates = routing_candidates();
        // Under default features (no office/binance/analytics) only non-gated
        // agents (none with tools=true) are returned — the fallback is office.
        // This test documents the expected size under specific feature combos.
        // Run `cargo test -p kawai-router` (no features) for the minimal set.
        // The office-cfg-gated agent won't appear here unless office feature is on.
        for c in &candidates {
            assert!(
                c.agent_id.starts_with("builtin."),
                "unexpected agent_id format: {}",
                c.agent_id
            );
        }
    }

    #[test]
    fn resolve_explicit_valid_id() {
        // Office is always present and enabled in the composition root.
        let id = resolve_start_agent("builtin.office", "any query");
        assert_eq!(id, "builtin.office");
    }

    #[test]
    fn resolve_auto_falls_back_to_office() {
        let id = resolve_start_agent("auto", "how does photosynthesis work?");
        assert_eq!(id, "builtin.office");
    }

    #[test]
    fn resolve_empty_falls_back_to_office() {
        let id = resolve_start_agent("", "hello");
        assert_eq!(id, "builtin.office");
    }
}
