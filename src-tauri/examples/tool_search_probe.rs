//! Probe: run raw hybrid searches against the remote Turso tool catalog and
//! print exactly what comes back — names + descriptions, in rank order.
//! Read-only (uses the client token from .env). No registry, no planner.
//!
//! Usage:
//!   cargo run --example tool_search_probe --features litert                 # built-in queries
//!   cargo run --example tool_search_probe --features litert -- "query saya"  # custom query

fn main() {
    kawai_lib::auth::load_dotenv();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(run()) {
            eprintln!("[search_probe] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[search_probe] FAIL: rebuild with --features litert");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    let cfg = kawai_tool_catalog::RemoteConfig::from_env()
        .ok_or("KAWAI_TURSO_* not configured in .env")?;
    let catalog = kawai_tool_catalog::Catalog::open_default(&cfg).await?;
    match catalog.sync().await {
        Ok(n) => println!("[probe] sync: {n} frames"),
        Err(e) => println!("[probe] sync (best-effort) failed: {e}"),
    }

    let model = kawai_embedding::build_providers_from_env();

    // Custom queries from argv, or a spread of representative goals.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let queries: Vec<String> = if args.is_empty() {
        vec![
            "buatkan deck presentasi penjualan dari data analytics".into(),
            "gabungkan dua file PDF dan pisahkan halamannya".into(),
            "analisis teknikal harga bitcoin, hitung RSI dan MACD".into(),
            "cari informasi di internet tentang berita terbaru dan baca isinya".into(),
            "ingat bahwa saya preferensi rapat sore hari".into(),
            "tulis artikel panjang tentang resep masakan indonesia".into(),
        ]
    } else {
        args
    };

    for query in &queries {
        println!("\n════ QUERY: {query}");
        let vecs = model
            .embed_strings(vec![query.clone()])
            .await
            .map_err(|e| format!("embed: {e}"))?;
        let Some(qvec) = vecs.into_iter().next() else {
            return Err("embed: empty response".into());
        };
        let hits = catalog.search(query, &qvec, 5).await?;
        if hits.is_empty() {
            println!("  (no results)");
            continue;
        }
        for (i, hit) in hits.iter().enumerate() {
            let desc: String = hit.description.chars().take(90).collect();
            println!("  {}. {} — {desc}{}", i + 1, hit.name, if hit.description.chars().count() > 90 { "…" } else { "" });
        }
    }

    println!("\n[probe] DONE");
    Ok(())
}
