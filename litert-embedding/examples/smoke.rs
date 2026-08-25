//! Headless evaluation harness for [`litert_embedding::LitertEmbedder`].
//!
//! Loads an embedding `.litertlm` model and reports, in order:
//! 1. output dimension + normalization state,
//! 2. pairwise cosine similarities across a mixed EN/ID sentence set
//!    (top/bottom pairs only),
//! 3. a mini retrieval check (rank of the intended document per query),
//! 4. latency: cold first batch vs warm average.
//!
//! Run via `./smoke.sh <model.litertlm>` (see script) so linking env vars are
//! wired automatically.

use std::process::ExitCode;
use std::time::{Duration, Instant};

use cognee_litert_lm::Backend;
use litert_embedding::{backend_name, EmbedderConfig, LitertEmbedder};

const SAMPLES: [&str; 8] = [
    "It is raining heavily in Jakarta today.",
    "Heavy rain falls over the capital this afternoon.",
    "The central bank raised its benchmark interest rate by 25 basis points.",
    "Monetary authorities tightened policy to curb inflation.",
    "Hujan deras mengguyur Jakarta hari ini.",
    "Bank sentral menaikkan suku bunga acuan sebesar 25 basis poin.",
    "The quarterly report shows revenue growth across all segments.",
    "Shares rallied after the earnings announcement exceeded forecasts.",
];

const DOCS: [&str; 4] = [
    "Jakarta weather forecast: afternoon thunderstorms with heavy rain expected until evening.",
    "The bank announced a 25 basis point rate hike after its monthly policy meeting.",
    "Recipe: nasi goreng requires rice, garlic, sweet soy sauce, and a fried egg on top.",
    "Quarterly earnings beat expectations as revenue grew twelve percent year over year.",
];

const QUERIES: [(&str, usize); 4] = [
    ("will it rain in jakarta tomorrow", 0),
    ("how much did interest rates go up", 1),
    ("cara memasak nasi goreng sederhana", 2),
    ("company financial results this quarter", 3),
];

fn parse_args() -> Option<(String, Backend)> {
    let mut args = std::env::args().skip(1);
    let mut model: Option<String> = None;
    let mut backend = Backend::Cpu;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--backend" => match args.next()?.to_lowercase().as_str() {
                "cpu" => backend = Backend::Cpu,
                "gpu" => backend = Backend::Gpu,
                _ => return None,
            },
            other if model.is_none() && !other.starts_with("--") => model = Some(other.to_string()),
            _ => return None,
        }
    }
    model.map(|m| (m, backend))
}

fn usage() {
    eprintln!("usage: smoke <model.litertlm> [--backend cpu|gpu]");
}

fn sample_label(samples: &[String], i: usize) -> &str {
    samples.get(i).map(String::as_str).unwrap_or("?")
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let Some((model_path, backend)) = parse_args() else {
        usage();
        return ExitCode::from(2);
    };

    println!("loading embedding model: {model_path} (backend={})", backend_name(&backend));
    let config = EmbedderConfig {
        backend,
        ..EmbedderConfig::default()
    };
    let started = Instant::now();
    let Ok(embedder) = LitertEmbedder::with_config(&model_path, config) else {
        eprintln!("failed to load model (see engine log above)");
        return ExitCode::from(1);
    };
    println!(
        "loaded in {:.1?}; dim={} normalize={}",
        started.elapsed(),
        embedder.dimension(),
        embedder.normalized()
    );

    let samples: Vec<String> = SAMPLES.iter().map(|s| s.to_string()).collect();
    let cold = Instant::now();
    let Ok(vectors) = embedder.embed(samples.clone()).await else {
        eprintln!("embedding failed");
        return ExitCode::from(1);
    };
    println!(
        "cold batch of {} texts in {:.1?}",
        vectors.len(),
        cold.elapsed()
    );

    println!("\n── most similar / least similar pairs ──");
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (i, a) in vectors.iter().enumerate() {
        for (j, b) in vectors.iter().enumerate().skip(i + 1) {
            pairs.push((LitertEmbedder::cosine(a, b), i, j));
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (sim, i, j) in pairs.iter().take(3) {
        println!(
            "  {sim:+.4}  [{i}] {} ↔ [{j}] {}",
            sample_label(&samples, *i),
            sample_label(&samples, *j)
        );
    }
    println!("  …");
    for (sim, i, j) in pairs.iter().rev().take(3) {
        println!(
            "  {sim:+.4}  [{i}] {} ↔ [{j}] {}",
            sample_label(&samples, *i),
            sample_label(&samples, *j)
        );
    }

    println!("\n── mini retrieval (rank of intended document) ──");
    let docs: Vec<String> = DOCS.iter().map(|d| d.to_string()).collect();
    let Ok(doc_vectors) = embedder.embed(docs).await else {
        eprintln!("doc embedding failed");
        return ExitCode::from(1);
    };
    let queries: Vec<String> = QUERIES.iter().map(|(q, _)| q.to_string()).collect();
    let Ok(query_vectors) = embedder.embed(queries).await else {
        eprintln!("query embedding failed");
        return ExitCode::from(1);
    };
    let mut hits = 0usize;
    for ((query, expected), qv) in QUERIES.iter().zip(query_vectors.iter()) {
        let expected_sim = doc_vectors
            .get(*expected)
            .map(|dv| LitertEmbedder::cosine(qv, dv))
            .unwrap_or(f64::NAN);
        let mut sims: Vec<(f64, usize)> = doc_vectors
            .iter()
            .enumerate()
            .map(|(idx, dv)| (LitertEmbedder::cosine(qv, dv), idx))
            .collect();
        sims.sort_by(|a, b| b.0.total_cmp(&a.0));
        let Some((top_sim, top_idx)) = sims.first().copied() else {
            println!("  ? {query:?}: no documents scored");
            continue;
        };
        let rank = sims
            .iter()
            .position(|(s, _)| (*s - expected_sim).abs() < 1e-12)
            .map_or(usize::MAX, |p| p + 1);
        let marker = if top_idx == *expected { "✓" } else { "✗" };
        if top_idx == *expected {
            hits += 1;
        }
        println!(
            "  {marker} {query:?} → top={top_idx} (expected {expected}), rank_of_expected={rank}, sim={top_sim:+.4}"
        );
    }
    println!("retrieval top-1: {hits}/{}", QUERIES.len());

    println!("\n── warm latency ──");
    const ROUNDS: u32 = 5;
    let mut total = Duration::ZERO;
    for _ in 0..ROUNDS {
        let t = Instant::now();
        if embedder.embed(samples.clone()).await.is_err() {
            eprintln!("warm embedding failed");
            return ExitCode::from(1);
        }
        total += t.elapsed();
    }
    let per_round = total / ROUNDS;
    println!(
        "{ROUNDS} rounds × {} texts: {:.1?} per round ({:.2?} per text)",
        samples.len(),
        per_round,
        per_round / samples.len() as u32
    );

    ExitCode::SUCCESS
}
