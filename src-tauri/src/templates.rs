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

use chrono::{Datelike, NaiveDate};

use kawai_router::template::{PlanTemplate, ResolvedSlots, Slot, TemplateRegistry};
use kawai_router::{TaskPlan, TaskStep};

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

/// Resolve one period argument into its inclusive `(from, to)` month bounds.
///
/// Accepted: `YYYY-MM`, `YYYY-MM-DD` (the month containing the date),
/// `MM/YYYY`, `DD/MM/YYYY` (the Indonesian day-first convention whenever the
/// first number cannot be a year), or a month name in English or Indonesian
/// with an optional 4-digit year. A bare month name means its LAST
/// occurrence: the current year, unless that month has not started yet, in
/// which case the previous year — a close is always backward-looking.
fn parse_period(input: &str, today: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    let text = input.trim().to_lowercase();
    if text.is_empty() {
        return Err("period is empty — name a month, e.g. '2026-10' or 'Oktober 2026'".into());
    }
    let numbers: Vec<u32> = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let year_word = numbers.iter().find(|n| **n >= 1000).copied();
    let month_word = text
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|s| !s.is_empty())
        .find_map(month_from_word);

    let (year, month) = match (numbers.as_slice(), month_word) {
        // YYYY-MM or YYYY-MM-DD: leading 4-digit year.
        ([y, m, ..], _) if *y >= 1000 => {
            validate_month(*m)?;
            (*y as i32, *m)
        }
        // DD/MM/YYYY or MM/YYYY: trailing 4-digit year.
        ([.., m, y], _) if *y >= 1000 => {
            validate_month(*m)?;
            (*y as i32, *m)
        }
        // D/M/Y day-first when the first number cannot be a year.
        ([d, m, y], None) if *y < 100 && *d >= 1 => {
            validate_month(*m)?;
            (2000 + *y as i32, *m)
        }
        // Two numbers with no year slot (e.g. "10 2026" caught above) are
        // ambiguous — refuse rather than guess.
        (_, Some(m)) => {
            let year = match year_word {
                Some(y) => y as i32,
                None => last_occurrence_year(m, today),
            };
            (year, m)
        }
        _ => {
            return Err(format!(
                "cannot read period {input:?} — use '2026-10', a month name like 'Oktober 2026', or '31/10/2026'"
            ))
        }
    };
    Ok(month_bounds(year, month))
}

fn validate_month(m: u32) -> Result<(), String> {
    (1..=12)
        .contains(&m)
        .then_some(())
        .ok_or_else(|| format!("month {m} is not 1-12"))
}

/// English + Indonesian month names, case-insensitively.
fn month_from_word(word: &str) -> Option<u32> {
    let names: [(&str, u32); 24] = [
        ("january", 1), ("february", 2), ("march", 3), ("april", 4), ("may", 5), ("june", 6),
        ("july", 7), ("august", 8), ("september", 9), ("october", 10), ("november", 11), ("december", 12),
        ("januari", 1), ("februari", 2), ("maret", 3), ("april", 4), ("mei", 5), ("juni", 6),
        ("juli", 7), ("agustus", 8), ("september", 9), ("oktober", 10), ("november", 11), ("desember", 12),
    ];
    names.iter().find(|(n, _)| *n == word).map(|(_, m)| *m)
}

/// A bare month means its last occurrence: this year, unless the month has
/// not started yet — then last year.
fn last_occurrence_year(month: u32, today: NaiveDate) -> i32 {
    let mut year = today.year();
    if NaiveDate::from_ymd_opt(year, month, 1).is_none_or(|first| first > today) {
        year -= 1;
    }
    year
}

fn month_bounds(year: i32, month: u32) -> (NaiveDate, NaiveDate) {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("validated month");
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("validated month");
    let last = next.pred_opt().expect("any date has a predecessor");
    (first, last)
}

fn close_step(
    id: &str,
    task: &str,
    tool: &str,
    args: serde_json::Value,
    depends_on: &[&str],
) -> TaskStep {
    TaskStep {
        id: id.to_string(),
        task: task.to_string(),
        tool: Some(tool.to_string()),
        arguments: args,
        depends_on: depends_on.iter().map(|s| (*s).to_string()).collect(),
        ..TaskStep::default()
    }
}

/// Build the monthly-close plan for one resolved period.
fn build_accounting_close(slots: &ResolvedSlots) -> Result<TaskPlan, String> {
    let period = slots.get("period").unwrap_or_default();
    let today = chrono::Local::now().date_naive();
    let (from, to) = parse_period(period, today)?;
    let args_period = serde_json::json!({ "from": from.to_string(), "to": to.to_string() });
    let args_as_of = serde_json::json!({ "as_of": to.to_string() });
    let steps = vec![
        close_step(
            "collect",
            "List every transaction in the period",
            "ledger_list_transactions",
            args_period.clone(),
            &[],
        ),
        close_step(
            "trial-balance",
            "Trial balance as of the period end",
            "ledger_trial_balance",
            args_as_of.clone(),
            &["collect"],
        ),
        close_step(
            "balance-sheet",
            "Balance sheet as of the period end",
            "ledger_balance_sheet",
            args_as_of.clone(),
            &["collect"],
        ),
        close_step(
            "income-statement",
            "Income statement over the period",
            "ledger_income_statement",
            args_period.clone(),
            &["collect"],
        ),
        close_step(
            "cash-flow",
            "Cash flow statement over the period",
            "ledger_cash_flow",
            args_period.clone(),
            &["collect"],
        ),
        close_step(
            "integrity-gate",
            "Gate: if is_valid is false, stop and report the issues instead of exporting",
            "ledger_integrity_check",
            args_as_of,
            &["trial-balance", "balance-sheet"],
        ),
        close_step(
            "gstr1-export",
            "Export the period's GSTR-1 portal JSON",
            "gstr1_export",
            serde_json::json!({ "year": from.year(), "month": from.month() as i64 }),
            &["integrity-gate"],
        ),
    ];
    Ok(TaskPlan {
        goal: format!("Tutup buku periode {from} s/d {to}"),
        steps,
        final_writer: None,
        summary: None,
        template: None, // stamped by the router, never by the builder
    })
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

/// Every template the router may claim. Add new pipelines here.
pub static TEMPLATES: &[&PlanTemplate] = &[
    &DESK,
    #[cfg(feature = "accounting")]
    &ACCOUNTING_MONTHLY_CLOSE,
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

    /// The close pipeline dispatches only merged-catalog accounting tools,
    /// the integrity gate runs before the export, and the export consumes
    /// the gate's decision (depends_on), never the other way round.
    #[test]
    fn accounting_close_dispatches_only_accounting_tools_gate_first() {
        let plan =
            build_accounting_close(&ResolvedSlots::new().with("period", "2026-10")).unwrap();
        const TOOLS: &[&str] = &[
            "ledger_list_transactions",
            "ledger_trial_balance",
            "ledger_balance_sheet",
            "ledger_income_statement",
            "ledger_cash_flow",
            "ledger_integrity_check",
            "gstr1_export",
        ];
        assert_eq!(plan.steps.len(), 7);
        for step in &plan.steps {
            let tool = step.tool.as_deref().expect("close steps dispatch tools");
            assert!(TOOLS.contains(&tool), "step {} dispatches {tool}", step.id);
        }
        let gate = plan.steps.iter().find(|s| s.id == "integrity-gate").unwrap();
        let export = plan.steps.iter().find(|s| s.id == "gstr1-export").unwrap();
        assert!(gate.depends_on.contains(&"trial-balance".to_string()));
        assert!(export.depends_on.contains(&"integrity-gate".to_string()));
        assert!(plan.goal.contains("2026-10-01") && plan.goal.contains("2026-10-31"));
    }

    #[test]
    fn accounting_close_refuses_without_a_period() {
        // Required-slot contract: `route_goal` routes to Plan before build;
        // build must not panic if reached anyway.
        assert!(build_accounting_close(&ResolvedSlots::new()).is_err());
    }

    #[test]
    fn parse_period_reads_iso_ranges_names_and_day_first_dates() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 18).unwrap();
        let (from, to) = parse_period("2026-10", today).unwrap();
        assert_eq!((from, to), (date(2026, 10, 1), date(2026, 10, 31)));
        // A full date means the month containing it.
        assert_eq!(parse_period("2026-03-15", today).unwrap().0, date(2026, 3, 1));
        // Day-first with a two-digit year.
        assert_eq!(parse_period("31/10/26", today).unwrap().1, date(2026, 10, 31));
        // Named month with an explicit year, English and Indonesian.
        assert_eq!(parse_period("March 2025", today).unwrap().1, date(2025, 3, 31));
        assert_eq!(parse_period("desember 2025", today).unwrap().1, date(2025, 12, 31));
        // Bare month = last occurrence: March 2026 already started, December
        // 2026 has not, so it folds back to 2025.
        assert_eq!(parse_period("march", today).unwrap().0, date(2026, 3, 1));
        assert_eq!(parse_period("december", today).unwrap().0, date(2025, 12, 1));
        // Garbage is a guidance error, never a guess.
        assert!(parse_period("sometime last year", today).is_err());
        assert!(parse_period("2026-13", today).is_err());
    }

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
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