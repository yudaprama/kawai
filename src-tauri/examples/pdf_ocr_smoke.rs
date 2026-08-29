//! Smoke test for `pdf_extract_text_structured` — the structured OCR pipeline.
//! Run with a real PDF path:
//! `cargo run --example pdf_ocr_smoke --features office -- /path/to/scanned.pdf`

#[cfg(feature = "office")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let pdf_path = std::env::args()
        .nth(1)
        .expect("usage: pdf_ocr_smoke <path-to-pdf>");

    // For this smoke we bypass the store and call pdf_oxide + OCR directly,
    // since we don't have a full user store in this headless example.
    let path = std::path::PathBuf::from(&pdf_path);
    assert!(path.is_file(), "not a file: {pdf_path}");

    // 1. Native extraction via pdf_oxide
    let doc = pdf_oxide::PdfDocument::open(&path)
        .unwrap_or_else(|e| panic!("pdf open: {e}"));
    let count = doc.page_count().unwrap();
    println!("PDF has {count} pages");

    let opts = pdf_oxide::converters::ConversionOptions::default();
    let page_count = count.min(3); // limit to first 3 pages for smoke
    for i in 0..page_count {
        let md = doc.to_markdown(i, &opts).unwrap_or_default();
        if !md.trim().is_empty() {
            println!("  page {} — native extraction OK ({})", i + 1, md.len());
        } else {
            println!("  page {} — blank (OCR fallback needed)", i + 1);
        }
    }

    // 2. Structured OCR extraction (render → PaddleOCR → OcrLine with bbox)
    let source = kawai_vision::ImageSource::local("smoke-test.pdf");

    // Render first page to test the OCR chain
    let render_opts = pdf_oxide::rendering::RenderOptions::with_dpi(150);
    let rendered = pdf_oxide::rendering::render_page(&doc, 0, &render_opts)
        .unwrap_or_else(|e| panic!("render page 0: {e}"));
    println!("Rendered page 0: {}x{} pixels", rendered.width, rendered.height);

    let desc = kawai_vision::default_chain()
        .describe(&source, &rendered.data)
        .await
        .unwrap_or_else(|e| panic!("OCR failed: {e}"));

    println!("Engine: {}", desc.engine);
    println!("Content length: {}", desc.content.len());

    if let Some(ref lines) = desc.ocr_lines {
        println!("OCR lines: {}", lines.len());
        for (i, line) in lines.iter().take(5).enumerate() {
            println!(
                "  [{i}] conf={:.2} bbox=({:.0},{:.0})-({:.0},{:.0}) text={}",
                line.confidence,
                line.bbox[0][0], line.bbox[0][1],
                line.bbox[2][0], line.bbox[2][1],
                &line.text.chars().take(60).collect::<String>(),
            );
        }
    } else {
        println!("No ocr_lines (engine did not use PaddleOCR)");
    }

    println!("pdf_ocr_smoke passed");
}

#[cfg(not(feature = "office"))]
fn main() {
    panic!("enable the office feature");
}
