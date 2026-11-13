//! Throwaway probe: how many distinct embeddings does the LOCAL LiteRT engine
//! produce for the same text? One fresh provider per iteration (exactly what
//! `build_litert_embedder()` gives each call site), plus repeated embeds on a
//! single shared provider.
//!
//! Usage: cargo run --example embedder_determinism_probe --features litert

#[path = "common/mod.rs"]
mod common;

fn main() {
    common::run_async("embedder_determinism", run());
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    let goal = "buatkan deck presentasi penjualan dari data analytics";

    // A: fresh provider per call (the narrow path's shape).
    for i in 0..5 {
        let model = kawai_embedding::build_litert_embedder();
        let v = model
            .embed_strings(kawai_embedding::EmbedRole::Query, vec![goal.to_string()])
            .await
            .map_err(|e| format!("fresh {i}: {e}"))?
            .into_iter()
            .next()
            .ok_or("empty")?;
        let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        println!("[embedder] fresh {i}: digest={} norm={norm:.6}", digest(&v));
    }

    // B: one shared provider, repeated embeds.
    let model = kawai_embedding::build_litert_embedder();
    for i in 0..5 {
        let v = model
            .embed_strings(kawai_embedding::EmbedRole::Query, vec![goal.to_string()])
            .await
            .map_err(|e| format!("shared {i}: {e}"))?
            .into_iter()
            .next()
            .ok_or("empty")?;
        let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        println!("[embedder] shared {i}: digest={} norm={norm:.6}", digest(&v));
    }

    // C: role matters? document-side embedding of the same text.
    let v = model
        .embed_strings(kawai_embedding::EmbedRole::Document, vec![goal.to_string()])
        .await
        .map_err(|e| format!("doc: {e}"))?
        .into_iter()
        .next()
        .ok_or("empty")?;
    let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    println!("[embedder] doc-role: digest={} norm={norm:.6}", digest(&v));

    // D: no prefix at all (raw embed_strings on the provider).
    let v = model
        .embed_for_tenant(None, kawai_embedding::EmbedRole::Query, vec![goal.to_string()])
        .await
        .map_err(|e| format!("raw: {e}"))?
        .into_iter()
        .next()
        .ok_or("empty")?;
    let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    println!("[embedder] embed_for_tenant(None): digest={} norm={norm:.6}", digest(&v));
    Ok(())
}

#[cfg(not(feature = "litert"))]
async fn run() -> Result<(), String> {
    Err("rebuild with --features litert".into())
}

fn digest(v: &[f64]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for x in v {
        h.update(x.to_bits().to_le_bytes());
    }
    hex::encode(&h.finalize()[..8])
}
