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
/// command and the router) produce the identical plan. `build_desk_plan`
/// panics on an empty ticker, so the required-slot check happens here — the
/// router must never be able to panic the planning path.
fn build_desk(slots: &ResolvedSlots) -> Result<TaskPlan, String> {
    let Some(ticker) = slots.get("ticker") else {
        return Err("desk template requires a ticker".into());
    };
    let analysts: Vec<&str> = slots.list("analysts");
    Ok(kawai_desk::build_desk_plan(
        ticker,
        slots.get_or("tradeDate", ""),
        &analysts,
        slots.get_or("domain", "stock"),
        slots.get_or("language", ""),
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

/// Every template the router may claim. Add new pipelines here.
pub static TEMPLATES: &[&PlanTemplate] = &[&DESK];

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

    /// The desk's steps dispatch exactly one tool, `desk_role` — which only
    /// exists in `build_desk_registry`, never in the planner catalog. That is
    /// why Fase 4 adds the `TaskPlan.template` registry hint; until then this
    /// test is the guard that the desk plan and the desk registry stay aligned.
    #[test]
    fn desk_plan_dispatches_only_the_desk_role_tool() {
        let plan = build_desk(&sample_slots(&DESK)).unwrap();
        assert!(!plan.steps.is_empty());
        for step in &plan.steps {
            assert_eq!(step.dispatch_key(), "desk_role", "step {}", step.id);
        }
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
                other => panic!("template {} has no sample for required slot {other}", template.id),
            }
        }
        slots
    }
}