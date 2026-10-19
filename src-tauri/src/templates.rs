//! The template registry — the composition root's instance of the template
//! contract in [`kawai_router::template`].
//!
//! It lives here, not in `kawai-router`, because every template's `build` fn
//! calls into a domain crate (`kawai-desk`, `kawai-youtube`, the Binance
//! toolsets) and all of those depend on `kawai-router` — the reverse edge does
//! not exist. Same split as `agent_registry.rs`: the runtime crate supplies the
//! contract, the application supplies the catalog.
//!
//! Registering a template here changes **nothing** at runtime until the router
//! is wired into `plan_task` (Fase 5). The fixed-pipeline commands keep calling
//! their `build_*_plan` functions directly; [`TEMPLATES`] is a second, parallel
//! view of the same pipeline shapes, and the completeness test below is what
//! keeps the two from drifting.


use kawai_router::template::{PlanTemplate, ResolvedSlots, Slot, TemplateRegistry};
use kawai_router::TaskPlan;

/// The Stock Research desk: analysts → bull/bear debate → research manager →
/// trader → three-persona risk debate → risk manager → portfolio manager.
///
/// Keyword set is deliberately narrow. "Analisis" alone appears in most
/// research-ish goals, so the match is anchored on terms that only a *market*
/// request carries, and [`PlanTemplate::requires_literal`] additionally demands
/// a ticker — keywords alone never claim this pipeline.
static DESK_SLOT_TICKER: Slot = Slot {
    name: "ticker",
    required: true,
    hint: "the ticker/symbol being analysed, e.g. NVDA, BTC, EURUSD",
};
static DESK_SLOT_ANALYSTS: Slot = Slot {
    name: "analysts",
    required: false,
    hint: "optional subset of market,social,news,fundamentals",
};

/// Wrap the desk's own builder so both entry points (the fixed-pipeline
/// command and the router) produce the identical plan. Inputs are validated
/// by `normalize_desk_args` BEFORE the plan exists — a bad slot value is a
/// plain router error the planner can recover from, never a silently wrong
/// run and never a panic on the planning path.
fn build_desk(slots: &ResolvedSlots) -> Result<TaskPlan, String> {
    let Some(ticker) = slots.get("ticker") else {
        return Err("desk template requires a ticker".into());
    };
    let analysts: Vec<&str> = slots.list("analysts");
    let args = kawai_desk::normalize_desk_args(
        ticker,
        slots.get_or("tradeDate", ""),
        &analysts,
        slots.get_or("domain", "stock"),
        slots.get_or("language", ""),
    )?;
    let analysts_ref: Vec<&str> = args.analysts.iter().map(String::as_str).collect();
    Ok(kawai_desk::build_desk_plan(
        &args.ticker,
        &args.trade_date,
        &analysts_ref,
        &args.domain,
        &args.language,
    ))
}

static DESK: PlanTemplate = PlanTemplate {
    id: "desk",
    purpose: "multi-analyst stock/crypto research with bull-bear and risk debate",
    keywords: &[
        "saham",
        "stock research",
        "trading plan",
        "rekomendasi",
        "analisis teknikal",
        "analisis fundamental",
        "bullish",
        "bearish",
        "risk review",
        "candle",
        "swing",
        "screener",
    ],
    requires_literal: true,
    // The desk trades Binance USDM futures — its subject must be a MEMBER of
    // the exchange's own listing (binance::usdm_symbols). "analisis saham
    // Bank BRI" hits the keyword and carries an uppercase literal, and BRI is
    // an IDX bank: without this membership check the router shipped it into a
    // 13-step futures pipeline that could not fetch a single candle.
    market_bound: true,
    slots: &[DESK_SLOT_TICKER, DESK_SLOT_ANALYSTS],
    build: build_desk,
};

/// The Accounting monthly close: collect the period's transactions, build the
/// four statements, gate on the integrity check, then export GSTR-1.
///
/// Unlike the desk, every step dispatches a tool that rides the MERGED
/// supervisor catalog (`ledger_*` / `gstr1_export`) —
/// `registry_kind_for_plan` already maps any non-desk template id to the
/// `Auto` registry for exactly this reason. The template is only registered
/// under the `accounting` cargo feature: with the feature off the router can
/// never claim it (fail closed; the planner is the always-valid fallback).
#[cfg(feature = "accounting")]
static ACCOUNTING_SLOT_PERIOD: Slot = Slot {
    name: "period",
    required: true,
    hint: "the book period to close, e.g. 'Oktober 2026', '2026-10', 'Oct 2026'",
};

/// Build the monthly-close plan for one resolved period — thin wrapper over
/// the domain builder the fixed `run_monthly_close` command also calls, so
/// chip and free-text produce the IDENTICAL plan (the `kawaii_desk` pattern).
#[cfg(feature = "accounting")]
fn build_accounting_close(slots: &ResolvedSlots) -> Result<TaskPlan, String> {
    accounting_tools::plan::build_monthly_close_plan(
        slots.get("period").unwrap_or_default(),
        chrono::Local::now().date_naive(),
    )
}

#[cfg(feature = "accounting")]
static ACCOUNTING_MONTHLY_CLOSE: PlanTemplate = PlanTemplate {
    id: "accounting_monthly_close",
    purpose: "monthly book close: collect the period's transactions, build the four statements, gate on the integrity check, then export GSTR-1",
    // Fixed bookkeeping idioms only — generic report words ("laporan bulanan")
    // would hijack analytics requests. The required `period` slot is the real
    // claim gate; requires_literal stays off because every alphanumeric goal
    // token trivially satisfies it.
    keywords: &["tutup buku", "penutupan buku", "monthly close", "close the books", "book closing"],
    requires_literal: false,
    market_bound: false,
    slots: &[ACCOUNTING_SLOT_PERIOD],
    build: build_accounting_close,
};

/// Trading Performance — the accounting wedge's flagship: sync fills, then
/// read the books back as a per-period performance review (win rate, PnL per
/// pair, fees, integrity gate). Period-driven like the monthly close; unlike
/// the audit it is not state-driven, so it is a router template with a
/// review gate rather than a fixed pipeline. Needs BOTH features — the stats
/// step dispatches a binance tool, the reads dispatch accounting tools — and
/// rides the merged `Auto` registry, which carries both.
#[cfg(all(feature = "accounting", feature = "binance"))]
static TRADING_PERFORMANCE: PlanTemplate = PlanTemplate {
    id: "trading_performance",
    purpose: "trading performance review: sync fills, read win rate and per-pair PnL and fees from the books, gate on ledger integrity",
    keywords: &["performa trading", "trading performance", "review pnl", "pnl review", "trading review"],
    requires_literal: false,
    market_bound: false,
    // `venue` is optional: absent reviews every exchange's fills, which is the
    // right default for a trader who runs more than one account.
    slots: &[ACCOUNTING_SLOT_PERIOD, ACCOUNTING_SLOT_VENUE],
    build: build_trading_performance,
};

/// Optional exchange scope for the performance review — read from the goal
/// when the user names one ("review MEXC performance"), otherwise every venue.
#[cfg(all(feature = "accounting", feature = "binance"))]
static ACCOUNTING_SLOT_VENUE: Slot = Slot {
    name: "venue",
    required: false,
    hint: "the exchange to review — 'binance' or 'mexc'; omit for every exchange",
};

/// Build the performance plan for one resolved period (and optional venue) —
/// thin wrapper over the domain builder the fixed `run_trading_performance`
/// command also calls.
#[cfg(all(feature = "accounting", feature = "binance"))]
fn build_trading_performance(slots: &ResolvedSlots) -> Result<TaskPlan, String> {
    accounting_tools::plan::build_trading_performance_plan(
        slots.get("period").unwrap_or_default(),
        chrono::Local::now().date_naive(),
        slots.get("venue").map(str::trim).filter(|v| !v.is_empty()),
    )
}

/// Every template the router may claim. Add new pipelines here.
pub static TEMPLATES: &[&PlanTemplate] = &[
    &DESK,
    #[cfg(feature = "accounting")]
    &ACCOUNTING_MONTHLY_CLOSE,
    #[cfg(all(feature = "accounting", feature = "binance"))]
    &TRADING_PERFORMANCE,
];

pub fn registry() -> TemplateRegistry<'static> {
    TemplateRegistry::new(TEMPLATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_template_id_is_unique() {
        let mut ids: Vec<&str> = TEMPLATES.iter().map(|t| t.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate template id in the registry");
    }

    #[test]
    fn every_template_declares_a_purpose_and_keywords() {
        for t in registry().iter() {
            assert!(!t.purpose.trim().is_empty(), "{} has no purpose", t.id);
            assert!(
                !t.keywords.is_empty(),
                "{} has no keywords — it can never be claimed",
                t.id
            );
            assert!(
                !t.slots.iter().any(|s| s.name.trim().is_empty()),
                "{} has an unnamed slot",
                t.id
            );
        }
    }

    #[test]
    fn registry_lookup_resolves_every_declared_template() {
        for t in registry().iter() {
            assert!(registry().get(t.id).is_some(), "{} unreachable", t.id);
        }
    }

    /// The completeness property: a template's `build` output must be a plan
    /// the scheduler can actually run. A template whose steps name a tool the
    /// registry does not carry fails at execute time with `UnknownTool`, long
    /// after the user waited for routing — so it is checked here instead.
    #[test]
    fn every_template_builds_a_structurally_valid_plan() {
        use kawai_router::plan::validate_structure;
        for t in registry().iter() {
            let slots = sample_slots(t);
            let plan = (t.build)(&slots).expect("build must succeed on a valid sample");
            validate_structure(&plan)
                .unwrap_or_else(|e| panic!("template {} built an invalid plan: {e}", t.id));
        }
    }

    /// The desk's steps dispatch exactly TWO tools: `desk_data` (the data
    /// phase — exactly one, and first) and `desk_role` (every role) — both
    /// exist ONLY in `build_desk_registry`, never in the planner catalog.
    /// This test is the guard that the desk plan and the desk registry stay
    /// aligned.
    #[test]
    fn desk_plan_dispatches_only_desk_tools() {
        let plan = build_desk(&sample_slots(&DESK)).unwrap();
        assert!(!plan.steps.is_empty());
        for step in &plan.steps {
            assert!(
                step.dispatch_key() == "desk_role" || step.dispatch_key() == "desk_data",
                "step {} dispatches {}",
                step.id,
                step.dispatch_key()
            );
        }
        assert_eq!(
            plan.steps.first().expect("data step").dispatch_key(),
            "desk_data",
            "the data phase runs first"
        );
        assert_eq!(
            plan.steps
                .iter()
                .filter(|s| s.dispatch_key() == "desk_data")
                .count(),
            1,
            "exactly one data step"
        );
    }

    #[test]
    fn desk_template_refuses_to_build_without_a_ticker() {
        // The required-slot contract: no ticker means this template does not
        // apply, and `route_goal` has already routed the goal to `Plan`.
        // `build` must not be reached with it, and must not panic if it is.
        assert!(build_desk(&ResolvedSlots::new()).is_err());
    }

    #[test]
    fn desk_template_accepts_a_ticker_and_defaults_the_rest() {
        let plan = build_desk(&ResolvedSlots::new().with("ticker", "nvda")).unwrap();
        assert!(plan.goal.contains("NVDA"), "goal: {}", plan.goal);
        assert_eq!(plan.final_writer, None, "deliverable writer synthesizes");
    }

    /// A slot sample that satisfies every required slot of `template`, so the
    /// completeness test builds real plans rather than skipping.
    fn sample_slots(template: &PlanTemplate) -> ResolvedSlots {
        let mut slots = ResolvedSlots::new();
        for slot in template.slots {
            if !slot.required {
                continue;
            }
            match slot.name {
                "ticker" => slots.set("ticker", "NVDA"),
                "url" => slots.set("url", "https://youtu.be/dQw4w9WgXcQ"),
                "period" => slots.set("period", "2026-10"),
                other => panic!("template {} has no sample for required slot {other}", template.id),
            }
        }
        slots
    }
}