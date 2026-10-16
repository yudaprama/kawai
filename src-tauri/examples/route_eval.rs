//! `route_eval` — offline accuracy harness for the deterministic router.
//!
//! Runs [`kawai_router::route_goal`] over a fixture of free-form goals against
//! the REAL registry (`kawai_lib::templates::registry()`) and prints the
//! confusion matrix. **No provider, no network, no model** — the router is a
//! pure function, so this is the gate that must pass before an LLM router pass
//! is added (Fase 6 of `PLAN-template-routing.md`).
//!
//! Usage:
//! ```sh
//! cargo run --example route_eval
//! cargo run --example route_eval -- --verbose
//! cargo run --example route_eval -- --strict   # non-zero exit on any mismatch
//! ```
//!
//! ## Why the fixtures are sentences, not parameters
//!
//! Template matching is only reachable from the free-text composer — the
//! fixed-pipeline forms still pass explicit slots. So the evaluation set must
//! be written the way a user actually types, including the awkward cases:
//! keywords with no subject, two-subject comparisons, and indicator names that
//! look like tickers. Scoring against well-formed parameter tuples would
//! measure a system that never ships.

use std::collections::BTreeMap;

use kawai_router::{route_goal, Route};

/// `(goal, expected route kind)`.
const FIXTURES: &[(&str, &str)] = &[
    // ── Single-subject market research: the desk's home turf ──────────────
    ("analisis saham NVDA", "template"),
    ("riset saham AAPL untuk 3 bulan", "template"),
    ("trading plan untuk BTC", "template"),
    ("rekomendasi bullish ETH", "template"),
    ("analisis teknikal EURUSD", "template"),
    ("risk review saham MSFT", "template"),
    // ── THE BLACK HOLE CLASS (PLAN-template-routing.md): valid ticker
    // shapes, wrong market. Membership in the exchange listing — not shape —
    // is the gate; these must fall to the planner, which answers them from
    // web/knowledge instead of running a futures pipeline on an IDX bank.
    ("analisis saham Bank BRI", "plan"),
    ("analisis teknikal BBRI", "plan"),
    ("riset saham TLKM", "plan"),
    // ── THE HOMONYM: `BANK` is a listed meme token whose ticker spells the
    // English word in the goal; "saham" intent must resolve to the equity
    // subset, never the coin.
    ("analisis saham Bank", "plan"),
    ("analisis teknikal BANK", "template"),
    // ── Keywords without a subject: must NOT claim a pipeline ─────────────
    ("analisis laporan keuangan q3", "plan"),
    ("bantu saya riset pasar", "plan"),
    ("saham mana yang menarik?", "plan"),
    ("rekomendasi bullish tanpa ticker", "plan"),
    // ── Lookalike tokens: indicators/currencies/formats are not tickers ───
    ("hitung RSI dan MACD", "plan"),
    ("harga dalam USD", "plan"),
    ("export ke file PDF", "plan"),
    // ── Multi-subject: a comparison, not a single-subject pipeline ────────
    ("bandingkan NVDA vs AAPL", "plan"),
    ("analisis BTC dan ETH", "plan"),
    // ── Non-market goals ──────────────────────────────────────────────────
    ("apa itu fotosintesis?", "direct"),
    ("halo", "direct"),
    ("terjemahkan good morning", "direct"),
    ("ringkasan youtube ini", "plan"),
    // ── Long, toolless goals must be planned, never answered directly ────
    (
        "tulis ringkasan panjang tentang sejarah ekonomi indonesia sejak perang dunia kedua",
        "plan",
    ),
    (
        "buat panduan langkah langkah shimmering DOGE dengan detail lengkap dan contoh",
        "plan",
    ),
];

fn main() {
    let registry = kawai_lib::templates::registry();
    // The market listing the eligibility gate checks against — seeded, not
    // fetched, so the harness is offline-deterministic. Deliberately WITHOUT
    // the black-hole fixtures' subjects (BRI/BBRI/TLKM are IDX, not here).
    kawai_lib::supervisor::seed_usdm_universe_for_test(
        &["NVDA", "AAPL", "BTC", "ETH", "EURUSD", "MSFT", "BANK"],
        // The tokenized-equity subset: `saham` goals may ONLY resolve here.
        &["NVDA", "AAPL", "MSFT"],
    );
    let verbose = std::env::args().any(|a| a == "--verbose");
    let strict = std::env::args().any(|a| a == "--strict");

    let mut hits = 0usize;
    let mut confusion: BTreeMap<(&str, String), usize> = BTreeMap::new();

    println!(
        "route_eval — {} fixtures, {} template(s) on the menu, offline\n",
        FIXTURES.len(),
        registry.len()
    );
    for line in registry.menu_lines().lines() {
        println!("  {line}");
    }
    println!();

    for (goal, expected) in FIXTURES {
        // The seeded set rides every decision — same eligibility the runtime
        // gate applies, offline-deterministic.
        let decision = route_goal(goal, kawai_lib::supervisor::universe_for_eval().as_ref(), &registry);
        // Score the route CLASS, not the template id: the menu is expected to
        // grow, and "some template claimed it" is the property that matters.
        let got = decision.route.kind().to_string();
        let ok = got == *expected;
        hits += usize::from(ok);
        *confusion.entry((expected, got)).or_default() += 1;

        let detail = match &decision.route {
            Route::Template(t) => t.id.to_string(),
            _ => decision.blocked_by_slots.join(","),
        };
        if verbose || !ok {
            println!(
                "  {}  {:<7} → {:<8} {:<16} (expected {expected})",
                if ok { "✓" } else { "✗" },
                truncate(goal, 56),
                decision.route.kind(),
                if detail.is_empty() { "-" } else { &detail }
            );
        }
    }

    println!("\nconfusion (expected → got):");
    for ((expected, got), n) in &confusion {
        println!(
            "  {} {expected:>8} → {got:<8} {n}",
            if expected == got { " " } else { "!" }
        );
    }
    println!(
        "\nclass agreement: {hits}/{} ({:.0}%)",
        FIXTURES.len(),
        100.0 * hits as f64 / FIXTURES.len() as f64
    );

    if strict && hits != FIXTURES.len() {
        eprintln!("--strict: {hits}/{} matched", FIXTURES.len());
        std::process::exit(1);
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}