//! Application composition root for the built-in agent registry.
//!
//! Domain definitions live in their own crates (kawai_office, binance,
//! kawai_analytics). Cross-cutting runtime tools and per-agent toolset
//! overrides are composed here, not inside kawai-agent. The runtime crate
//! provides the loop and the contract types, but does NOT own the catalog.

use kawai_agent_contract::{
    no_capability, no_confirmation, AgentCapabilities, AgentContext, AgentDefinition, AgentRegistry,
};

#[cfg(all(feature = "codegraph", feature = "litert"))]
use codegraph::{CodegraphExploreTool, CodegraphStatusTool};

// Re-export contract types used by transport wrappers.
pub use kawai_agent_contract::AgentInfo;

/// Fallback persona for agents whose domain feature is not compiled in.
const FALLBACK_PERSONA: &str = "You are kawai, a helpful, concise personal assistant.";

// ── Agent IDs ───────────────────────────────────────────────────────────────

pub const OFFICE_AGENT_ID: &str = "builtin.office";
pub const PRESENTATION_AGENT_ID: &str = "builtin.presentation";
pub const BINANCE_AGENT_ID: &str = "builtin.binance";
pub const ANALYTICS_AGENT_ID: &str = "builtin.analytics";
pub const ENTERTAINMENT_AGENT_ID: &str = "builtin.entertainment";
/// Read-only Monad EVM chain reporter (wallet snapshot, token reads, tx
/// status, transfer history). Feature "monad".
pub const MONAD_AGENT_ID: &str = "builtin.monad";

/// Build the agent catalog list from the built-in registry.
pub fn list_agents() -> Vec<AgentInfo> {
    builtin().list()
}

// ── Tool builders ───────────────────────────────────────────────────────────

/// Office gets knowledge_search, graph tools, and cloud subagent tools.
#[cfg(feature = "litert")]
pub fn office_tools(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let mut set = (kawai_office::agent::definition().build_tools)(context, remote_configured)?;
    set.add_tool(kawai_knowledge::tools::KnowledgeSearchTool(
        context.user_id.to_string(),
        context.session_id,
    ));
    kawai_knowledge::graph::extend_toolset(&mut set, context.user_id);
    Some(add_runtime_tools(set, context, remote_configured, true))
}

/// Presentation gets deck authoring, source reading, knowledge search, and
/// cloud synthesis — but not document editing or PDF mutation tools.
#[cfg(feature = "litert")]
pub fn presentation_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let mut set = (kawai_office::agent::presentation_definition().build_tools)(
        context,
        remote_configured,
    )?;
    set.add_tool(kawai_knowledge::tools::KnowledgeSearchTool(
        context.user_id.to_string(),
        context.session_id,
    ));
    Some(add_runtime_tools(set, context, remote_configured, false))
}

/// Binance gets web read/search (cross-cutting) and cloud subagent tools.
#[cfg(feature = "litert")]
pub fn binance_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(all(feature = "binance", not(target_os = "android")))]
    {
        let mut set = (::binance::agent::definition().build_tools)(context, remote_configured)?;
        if webread::any_engine() {
            set.add_tool(webread::WebReadTool(context.user_id.to_string()));
            set.add_tool(webread::WebSearchTool(context.user_id.to_string()));
        }
        return Some(add_runtime_tools(set, context, remote_configured, false));
    }
    #[cfg(not(all(feature = "binance", not(target_os = "android"))))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Analytics: delegates entirely to its own tool builder + cloud subagent tools.
#[cfg(feature = "litert")]
pub fn analytics_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let set = (kawai_analytics::agent::definition().build_tools)(context, remote_configured)?;
    Some(add_runtime_tools(set, context, remote_configured, false))
}

/// Append the runtime-owned cross-cutting tools: memory recall (always),
/// artifact_recall (always), deep_write (when remote is configured), and
/// draft_document (only for agents whose definition says they support it).
#[cfg(feature = "litert")]
fn add_runtime_tools(
    mut set: kawai_tools::ToolSet,
    context: &AgentContext<'_>,
    remote_configured: bool,
    supports_draft_document: bool,
) -> kawai_tools::ToolSet {
    set.add_tool(kawai_memory::tools::MemorySearchTool(
        context.user_id.to_string(),
    ));
    set.add_tool(kawai_memory::tools::MemoryGraphSearchTool(
        context.user_id.to_string(),
    ));
    set.add_tool(kawai_agent::ArtifactRecall);
    // Cross-run memory: lets a run read earlier runs' step outputs (the
    // deliverable chain — "enhance the previous analysis"). Identity is
    // bound here; the model can never supply user/session.
    set.add_tool(kawai_agent::SessionStepResultsTool(
        context.user_id.to_string(),
        context.session_id,
    ));
    // Per-device CLI executor (PLAN-cli-tools.md): cross-cutting like
    // memory_search, but only when this machine actually has CLIs. The
    // inventory snapshot is taken here so registry, prompt block, and
    // dispatch see one consistent view. NEVER seeded into the Turso tool
    // catalog — catalog_composition::PER_DEVICE_TOOLS excludes it.
    if !kawai_cli::inventory().is_empty() {
        let mut tool = kawai_cli::CliRunTool::from_cached_inventory(
            context.user_id,
            context.session_id,
        );
        // Attachments become addressable by filename: materialize every file
        // attached to this session into a per-session CLI workspace and make
        // it cli_run's default CWD. Best-effort — on any failure the tool
        // stays on the process CWD (previous behavior).
        if let Some(dir) = session_cli_workspace(context.user_id, context.session_id) {
            tool = tool.with_work_dir(dir);
        }
        set.add_tool(tool);
    }
    #[cfg(feature = "codegraph")]
    {
        // Hot-path agent tools — LRU-cached sidecar (phase0), native (phase1) when available.
        // Added to every agent so explore is always one call away.
        set.add_tool(CodegraphExploreTool);
        set.add_tool(CodegraphStatusTool);
    }
    if remote_configured {
        set.add_tool(kawai_agent::DeepWrite);
        set.add_tool(kawai_agent::PlanTask);
        set.add_tool(kawai_agent::PlanRevise);
        if supports_draft_document {
            set.add_tool(kawai_agent::DraftDocument);
        }
    }
    set
}

/// Tool builder for disabled/unavailable agents.
/// Session CLI workspace: `<user_data_dir>/cli_workspace/session-<id>/`.
/// Every file attached to the session is copied in under its original name
/// (via the office store), and `cli_run` defaults its CWD here — so a
/// command like `sips thumbnail_image.png …` addresses an attachment by
/// filename without any export step. Copying is fire-and-forget (the path is
/// deterministic; the first command runs seconds later); any failure is
/// non-fatal — the tool just keeps the process CWD.
fn session_cli_workspace(user_id: &str, session_id: i64) -> Option<std::path::PathBuf> {
    let dir = kawai_paths::user_data_dir(user_id)
        .join("cli_workspace")
        .join(format!("session-{session_id}"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[cli_workspace] mkdir {}: {e}", dir.display());
        return None;
    }
    // Materialize off the synchronous toolset-build path. Inside a tokio
    // runtime (agent turn) we spawn; headless contexts without a runtime
    // materialize inline via a scratch single-thread runtime.
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(materialize_session_files(user_id.to_string(), session_id, dir.clone()));
        }
        Err(_) => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()?;
            rt.block_on(materialize_session_files(user_id.to_string(), session_id, dir.clone()));
        }
    }
    Some(dir)
}

async fn materialize_session_files(user_id: String, session_id: i64, dir: std::path::PathBuf) {
    let Ok(conn) = crate::logic::db_connection(&user_id).await else {
        eprintln!("[cli_workspace] db_connection failed");
        return;
    };
    let Ok(mut rows) = conn
        .query(
            "SELECT file_id FROM session_files WHERE session_id = ?",
            vec![session_id],
        )
        .await
    else {
        eprintln!("[cli_workspace] session_files query failed");
        return;
    };
    let mut want: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        match rows.next().await {
            Ok(Some(row)) => {
                if let Ok(id) = row.get::<String>(0) {
                    want.insert(id);
                }
            }
            _ => break,
        }
    }
    let files = match kawai_office::list_files(&user_id) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[cli_workspace] list_files: {e}");
            return;
        }
    };
    for f in &files {
        if !want.contains(&f.id) {
            continue;
        }
        let dest = dir.join(kawai_office::store::sanitize_component(&f.original_name));
        if dest.exists() {
            continue; // already materialized
        }
        if let Err(e) = kawai_office::export_file(&user_id, &f.id, Some(&dest.to_string_lossy())) {
            eprintln!("[cli_workspace] export {}: {e}", f.id);
        }
    }
}

fn unavailable_tools(_: &AgentContext<'_>, _: bool) -> Option<kawai_tools::ToolSet> {
    None
}

/// Create a disabled placeholder definition for agents whose domain
/// feature is not compiled in.
fn unavailable_definition(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    enabled: bool,
) -> AgentDefinition {
    AgentDefinition {
        id,
        name,
        description,
        tools: false,
        enabled,
        persona: FALLBACK_PERSONA,
        build_tools: unavailable_tools,
        capabilities: AgentCapabilities::default(),
        capability_for_tool: no_capability,
        confirmation_for_tool: no_confirmation,
        summary_directive: None,
    }
}

// ── Registry construction ───────────────────────────────────────────────────

/// Entertainment tools: anime/manga, books, TV, music, poetry, and photos.
/// Jikan (MyAnimeList) tools carry a Wikipedia fallback for upstream MAL
/// outages; the rest are plain HTTP tools.
#[cfg(feature = "litert")]
pub fn entertainment_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let _ = (context, remote_configured);
    Some(entertainment::all_tools())
}

/// Monad: strictly read-only chain tools (wallet snapshot via Multicall3,
/// ERC-20 balance/info, gas, chain status, tx receipts, bounded Transfer log
/// scans, allowance). RPC + contracts come from `logic::monad_contracts`
/// (NETWORKS.md mirror) and are pinned here — the model never supplies an
/// RPC URL. The device wallet address rides as the zero-arg default on
/// desktop (keychain is desktop-only); web builds pass explicit addresses.
/// Web read/search ride along when an engine exists. No cloud-writer tools:
/// the agent is a pure reporter.
#[cfg(feature = "litert")]
pub fn monad_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(all(feature = "monad", not(target_os = "android")))]
    {
        // Keychain resolution is desktop-only; other builds take explicit
        // addresses.
        #[cfg(feature = "desktop")]
        let device_wallet = crate::logic::monad_wallet::address()
            .ok()
            .flatten()
            .map(|w| w.address);
        #[cfg(not(feature = "desktop"))]
        let device_wallet: Option<String> = None;
        monad_tools_inner(device_wallet, context, remote_configured)
    }
    #[cfg(not(all(feature = "monad", not(target_os = "android"))))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Catalog-seed/drift variant: builds the same toolset with NO device wallet
/// bound. The Turso catalog is global curation — one dev machine's keychain
/// state must never leak into it (the `PER_DEVICE_TOOLS` principle), and
/// seeding/drift-checking must never touch the OS keychain (a test or CLI
/// binary has no keychain ACL and would hang on a securityd prompt).
#[cfg(feature = "litert")]
pub fn monad_tools_for_catalog(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    monad_tools_inner(None, context, remote_configured)
}

#[cfg(feature = "litert")]
fn monad_tools_inner(
    device_wallet: Option<String>,
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(all(feature = "monad", not(target_os = "android")))]
    {
        use monad_tools::{ChainConfig, TokenPreset};
        use crate::logic::monad_contracts as contracts;
        let config = ChainConfig {
            rpc_url: contracts::rpc().to_string(),
            chain_label: if contracts::TESTNET { "Monad Testnet" } else { "Monad Mainnet" },
            explorer_tx_base: if contracts::TESTNET {
                "https://testnet.monadexplorer.com/tx/"
            } else {
                "https://monadexplorer.com/tx/"
            },
            stablecoin: TokenPreset {
                label: contracts::stablecoin_symbol(),
                address: contracts::stablecoin().to_string(),
                decimals: contracts::stablecoin_decimals(),
            },
            kawai: TokenPreset {
                label: "KAWAI",
                address: contracts::kawai_token().to_string(),
                decimals: contracts::KAWAI_DECIMALS,
            },
            vault: contracts::vault().to_string(),
            multicall3: contracts::multicall3().to_string(),
        };
        let mut set = monad_tools::toolset(config, device_wallet);
        if webread::any_engine() {
            set.add_tool(webread::WebReadTool(context.user_id.to_string()));
            set.add_tool(webread::WebSearchTool(context.user_id.to_string()));
        }
        let _ = remote_configured;
        return Some(set);
    }
    #[cfg(not(all(feature = "monad", not(target_os = "android"))))]
    {
        let _ = (device_wallet, context, remote_configured);
        None
    }
}

macro_rules! generated_http_tools {
    ($name:ident, $crate_name:ident) => {
        #[cfg(feature = "litert")]
        pub fn $name(
            context: &AgentContext<'_>,
            remote_configured: bool,
        ) -> Option<kawai_tools::ToolSet> {
            let _ = (context, remote_configured);
            Some($crate_name::all_tools())
        }
    };
}

generated_http_tools!(weather_geo_tools_for_supervisor, weather_geo);
generated_http_tools!(news_media_tools_for_supervisor, news_media);
generated_http_tools!(sports_tools_for_supervisor, sports);
generated_http_tools!(food_drink_tools_for_supervisor, food_drink);
generated_http_tools!(geospace_tools_for_supervisor, geospace);
generated_http_tools!(knowledge_tools_for_supervisor, knowledge);
generated_http_tools!(religion_tools_for_supervisor, religion);
generated_http_tools!(utility_tools_for_supervisor, utility);
generated_http_tools!(coinmarketcap_tools_for_supervisor, coinmarketcap);

/// Stock/social finance tools: keyed stock providers (TwelveData/AlphaVantage/
/// Tiingo, each with a keyless StockTwits fallback) plus the StockTwits-only
/// social tools (sentiment/messages/trending). yfinance provides extended
/// financial statements (balance sheet, cash flow, income statement) and
/// insider transactions. Crypto is intentionally excluded — the Binance
/// toolset already covers it. Always available (pure HTTP, no native deps),
/// so not feature-gated beyond `litert`.
#[cfg(feature = "litert")]
pub fn finance_tools_for_supervisor(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    let _ = (context, remote_configured);
    Some(finance::toolset_for(&[
        // Price/quote tools (TwelveData/AlphaVantage + StockTwits fallback)
        "get_stock_price",
        "get_stock_quote",
        "get_stock_detail",
        "get_stock_history",
        "get_stock_fundamentals",
        "get_stock_financials",
        "search_stock",
        // Social tools (StockTwits)
        "stock_sentiment",
        "stock_social_feed",
        "trending_stocks",
        // Extended financial statements (yfinance)
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
        "get_insider_transactions",
        // News tools (yfinance)
        "get_stock_news",
        // Market intelligence tools
        "get_macro_indicators",
        "get_prediction_markets",
        "get_verified_market_snapshot",
        // Reddit and sector tools
        "get_reddit_posts",
        "get_sector_performance",
        // Earnings and news sentiment (Alpha Vantage)
        "get_earnings_data",
        "get_news_sentiment",
    ]))
}

/// Build the built-in agent registry by composing domain definitions with
/// cross-cutting tools and capability overrides.
#[cfg(feature = "litert")]
pub fn builtin() -> AgentRegistry {
    let office = {
        let mut d = kawai_office::agent::definition();
        d.build_tools = office_tools;
        d
    };

    let presentation = {
        let mut d = kawai_office::agent::presentation_definition();
        d.build_tools = presentation_tools_for_supervisor;
        d
    };

    let binance = {
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        {
            let mut d = ::binance::agent::definition();
            d.build_tools = binance_tools_for_supervisor;
            d
        }
        #[cfg(not(all(feature = "binance", not(target_os = "android"))))]
        unavailable_definition(
            BINANCE_AGENT_ID,
            "Binance",
            "Crypto market data and technical analysis on Binance spot.",
            false,
        )
    };

    let analytics = {
        let mut d = kawai_analytics::agent::definition();
        d.build_tools = analytics_tools_for_supervisor;
        d
    };

    let entertainment = AgentDefinition {
        id: ENTERTAINMENT_AGENT_ID,
        name: "Entertainment",
        description: "Anime, manga, books, television, music, poetry, and photos.",
        tools: true,
        enabled: true,
        persona: FALLBACK_PERSONA,
        build_tools: entertainment_tools_for_supervisor,
        capabilities: AgentCapabilities::default(),
        capability_for_tool: no_capability,
        confirmation_for_tool: no_confirmation,
        summary_directive: None,
    };

    let monad = {
        #[cfg(all(feature = "monad", not(target_os = "android")))]
        {
            let mut d = monad_tools::agent::definition();
            d.build_tools = monad_tools_for_supervisor;
            d
        }
        #[cfg(not(all(feature = "monad", not(target_os = "android"))))]
        unavailable_definition(
            MONAD_AGENT_ID,
            "Monad",
            "Read-only Monad EVM wallet and chain data.",
            false,
        )
    };

    AgentRegistry::new(vec![office, presentation, binance, analytics, entertainment, monad])
}

/// Non-litert build: all agents are disabled placeholders.
#[cfg(not(feature = "litert"))]
pub fn builtin() -> AgentRegistry {
    AgentRegistry::new(vec![
        unavailable_definition(
            OFFICE_AGENT_ID,
            "Office",
            "Your on-device assistant for documents, PDFs, spreadsheets, and chat.",
            false,
        ),
        unavailable_definition(
            PRESENTATION_AGENT_ID,
            "Presentation",
            "Create clear presentation decks from your documents, data, and research.",
            false,
        ),
        unavailable_definition(
            BINANCE_AGENT_ID,
            "Binance",
            "Crypto market data and technical analysis on Binance spot.",
            false,
        ),
        unavailable_definition(
            ANALYTICS_AGENT_ID,
            "Analytics",
            "Structured queries over your data files: filter, aggregate, rank.",
            false,
        ),
        unavailable_definition(
            ENTERTAINMENT_AGENT_ID,
            "Entertainment",
            "Anime, manga, books, television, music, poetry, and photos.",
            false,
        ),
        unavailable_definition(
            MONAD_AGENT_ID,
            "Monad",
            "Read-only Monad EVM wallet and chain data.",
            false,
        ),
    ])
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_have_stable_order_and_ids() {
        let registry = builtin();
        assert_eq!(
            registry
                .list()
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            [
                OFFICE_AGENT_ID,
                PRESENTATION_AGENT_ID,
                BINANCE_AGENT_ID,
                ANALYTICS_AGENT_ID,
                ENTERTAINMENT_AGENT_ID,
                MONAD_AGENT_ID,
            ]
        );
    }

    #[cfg(all(feature = "litert", feature = "monad", not(target_os = "android")))]
    #[test]
    fn monad_definition_registers_read_only() {
        // Deliberately does NOT call build_tools: the real builder resolves
        // the device wallet from the OS keychain, and a test binary has no
        // keychain ACL (it would hang on a securityd prompt). Toolset shape
        // is pinned by monad-tools' own tests; here we pin the wiring.
        let registry = builtin();
        let def = registry
            .resolve(MONAD_AGENT_ID)
            .expect("monad definition registered");
        assert_eq!(def.id, MONAD_AGENT_ID);
        assert!(def.tools, "monad agent carries tools");
        // Read-only agent: no confirmation path, no cloud writer.
        assert!(
            def.confirmation_for_tool("monad_send", &serde_json::json!({}))
                .is_none()
        );
    }

    #[test]
    fn office_is_resolvable_when_litert_is_available() {
        let registry = builtin();
        #[cfg(feature = "litert")]
        assert!(registry.resolve(OFFICE_AGENT_ID).is_some());
        #[cfg(not(feature = "litert"))]
        assert!(registry.resolve(OFFICE_AGENT_ID).is_none());
    }

    #[test]
    fn presentation_is_enabled_with_office_tools() {
        let registry = builtin();
        #[cfg(feature = "litert")]
        assert!(registry.resolve(PRESENTATION_AGENT_ID).is_some());
        #[cfg(not(feature = "litert"))]
        assert!(registry.resolve(PRESENTATION_AGENT_ID).is_none());
    }

    #[test]
    fn optional_agents_are_enabled_only_with_their_capability() {
        let registry = builtin();

        #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
        assert!(registry.resolve(BINANCE_AGENT_ID).is_some());
        #[cfg(any(
            not(feature = "litert"),
            not(feature = "binance"),
            target_os = "android"
        ))]
        assert!(registry.resolve(BINANCE_AGENT_ID).is_none());

        #[cfg(feature = "litert")]
        assert!(registry.resolve(ANALYTICS_AGENT_ID).is_some());
        #[cfg(not(feature = "litert"))]
        assert!(registry.resolve(ANALYTICS_AGENT_ID).is_none());
    }

    #[test]
    fn unknown_agent_is_not_resolvable() {
        assert!(builtin().resolve("builtin.missing").is_none());
    }

    // ── tool-manifest regression tests ───────────────────────────────────────

    #[cfg(feature = "litert")]
    #[test]
    fn office_toolset_includes_knowledge_and_runtime_tools() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let registry = builtin();
        let set = registry
            .build_tools(OFFICE_AGENT_ID, &ctx, false)
            .expect("office tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"knowledge_search"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
        assert!(
            !names.contains(&"deep_write"),
            "remote off must not add deep_write: {names:?}"
        );
    }

    #[cfg(feature = "litert")]
    #[test]
    fn presentation_toolset_is_focused_on_decks_and_sources() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(PRESENTATION_AGENT_ID, &ctx, false)
            .expect("presentation tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"office_create_deck"), "{names:?}");
        assert!(names.contains(&"office_export_deck"), "{names:?}");
        assert!(names.contains(&"office_read_document"), "{names:?}");
        assert!(names.contains(&"knowledge_search"), "{names:?}");
        assert!(!names.contains(&"office_edit_document"), "{names:?}");
        assert!(!names.contains(&"pdf_merge"), "{names:?}");
        assert!(!names.contains(&"draft_document"), "{names:?}");
    }

    #[cfg(feature = "litert")]
    #[test]
    fn office_remote_toolset_adds_deep_write_and_draft() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(OFFICE_AGENT_ID, &ctx, true)
            .expect("office remote tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"deep_write"), "{names:?}");
        assert!(names.contains(&"draft_document"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
    }

    #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
    #[test]
    fn binance_toolset_includes_market_and_runtime_tools() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let registry = builtin();
        let set = registry
            .build_tools(BINANCE_AGENT_ID, &ctx, false)
            .expect("binance tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"crypto_price"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
        assert!(
            !names.contains(&"deep_write"),
            "remote off must not add deep_write: {names:?}"
        );
        assert!(
            !names.contains(&"draft_document"),
            "binance never carries draft_document: {names:?}"
        );
    }

    #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
    #[test]
    fn binance_remote_adds_deep_write_no_draft() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(BINANCE_AGENT_ID, &ctx, true)
            .expect("binance remote tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"deep_write"), "{names:?}");
        assert!(
            !names.contains(&"draft_document"),
            "binance never carries draft_document: {names:?}"
        );
    }

    #[cfg(feature = "litert")]
    #[test]
    fn analytics_toolset_respects_sql_profiles_and_remote() {
        use kawai_agent_contract::SqlProfile;
        let ctx_no_profiles = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let ctx_with_profiles = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: Some(&[SqlProfile {
                name: "prod".into(),
                source: "postgresql://...".into(),
            }]),
        };
        let registry = builtin();

        let no_profiles = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_no_profiles, false)
            .expect("analytics tools");
        let names: Vec<&str> = no_profiles
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(!names.contains(&"data_tables"), "{names:?}");
        assert!(names.contains(&"data_schema"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");

        let with_profiles = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_with_profiles, false)
            .expect("analytics tools with profiles");
        let names_prof: Vec<&str> = with_profiles
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names_prof.contains(&"data_tables"), "{names_prof:?}");
        assert!(
            !names_prof.contains(&"deep_write"),
            "remote off must not add deep_write: {names_prof:?}"
        );

        let remote = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_with_profiles, true)
            .expect("analytics remote tools");
        let remote_names: Vec<&str> = remote
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(remote_names.contains(&"deep_write"), "{remote_names:?}");
        assert!(
            !remote_names.contains(&"draft_document"),
            "analytics never carries draft_document: {remote_names:?}"
        );
    }

    // Binance-only: without the feature the agent has no toolset at all
    // (build_tools returns None), so the assertions below are meaningless.
    #[cfg(all(feature = "litert", feature = "binance"))]
    #[test]
    fn binance_webread_tools_present_when_engine_available() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(BINANCE_AGENT_ID, &ctx, false)
            .expect("binance tools");
        #[cfg(feature = "binance")]
        if webread::any_engine() {
            let names: Vec<&str> = set
                .get_tool_definitions()
                .iter()
                .map(|d| d.name.as_str())
                .collect();
            assert!(
                names.contains(&"web_read"),
                "engine available, expected web_read: {names:?}"
            );
        }
    }
}
