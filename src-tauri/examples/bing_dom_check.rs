//! Diagnostic probe: run the REAL BING_EXTRACTOR (and a raw DOM census)
//! inside the hidden webview against a Bing SERP, to see exactly what the
//! web_search tier-0 extractor sees.
//!
//! Usage: cargo run --example bing_dom_check -- <serp-url>

use std::sync::Arc;

use kawai_lib::webview_engine::TauriWebViewFetch;
use webread::scrape::BING_EXTRACTOR;
use webread::WebViewFetch;

fn main() {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| {
            "https://www.bing.com/search?q=manfaat+AI+untuk+pekerjaan+kantor&count=20&mkt=en-US&setlang=en-US&cc=US"
                .to_string()
        });

    tauri::Builder::default()
        .setup(move |app| {
            let engine = Arc::new(TauriWebViewFetch::new(app.handle().clone()));
            let url = url.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                // DOM census: counts + first anchor hrefs.
                let census = r#"(function(){
                    var lis=document.querySelectorAll('li.b_algo').length;
                    var anchors=[];
                    var all=document.querySelectorAll('h2 a, li a[href]');
                    for(var i=0;i<all.length&&anchors.length<12;i++){
                        var h=all[i].getAttribute('href')||'';
                        if(h.indexOf('http')===0) anchors.push(h.substring(0,90));
                    }
                    return JSON.stringify({b_algo:lis,title:document.title,anchors:anchors});
                })()"#;
                match rt.block_on(engine.eval_page(&url, census)) {
                    Ok(p) => println!("[census] {p}"),
                    Err(e) => println!("[census] ERROR: {}", e.0),
                }
                match rt.block_on(engine.eval_page(&url, BING_EXTRACTOR)) {
                    Ok(p) => {
                        let head: String = p.chars().take(600).collect();
                        println!("[extractor] len={} head:\n{head}", p.chars().count());
                    }
                    Err(e) => println!("[extractor] ERROR: {}", e.0),
                }
                std::process::exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
