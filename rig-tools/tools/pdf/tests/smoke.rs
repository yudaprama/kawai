//! End-to-end smoke test: exercises each tool against a real `pdfcli` binary.
//!
//! Set `PDFCLI_BIN` to the built binary (e.g.
//! `go build -o /tmp/pdfcli ./cmd/pdfcli`) and run:
//!
//!     PDFCLI_BIN=/tmp/pdfcli cargo test -- --nocapture

use pdf::ToolOptions;
use rig::tool::PortableTool;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn sample_pdf() -> String {
    repo_root()
        .join("pdf/creator/testdata/lorem.pdf")
        .to_string_lossy()
        .into_owned()
}

fn opts() -> ToolOptions {
    ToolOptions::default()
}

#[tokio::test]
async fn search_replace_roundtrip() {
    let tool = pdf::PdfSearchReplaceTool::new(opts());
    let out = tool
        .call(pdf::PdfSearchReplaceArgs {
            pattern: "Lorem".into(),
            replacement: "LoremXP".into(),
            pages: None,
            input_path: sample_pdf(),
            output_path: "/tmp/rig_pdf_replace.pdf".into(),
        })
        .await
        .unwrap();
    println!("{out}");
    assert!(out.contains("Replaced"));
    assert!(out.contains("/tmp/rig_pdf_replace.pdf"));
}

#[tokio::test]
async fn extract_and_info() {
    let tool = pdf::PdfExtractTextTool::new(opts());
    let out = tool
        .call(pdf::PdfExtractTextArgs {
            pages: None,
            input_path: sample_pdf(),
        })
        .await
        .unwrap();
    println!("extract: {out}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(!v["pages"].as_object().unwrap().is_empty());

    let info = pdf::PdfPageInfoTool::new(opts());
    let out = info
        .call(pdf::PdfPageInfoArgs {
            input_path: sample_pdf(),
        })
        .await
        .unwrap();
    println!("info: {out}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["pageCount"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn merge_split_metadata() {
    let out_dir = std::env::temp_dir().join(format!("rig_pdf_{}", std::process::id()));
    std::fs::create_dir_all(&out_dir).unwrap();
    let merged = out_dir.join("merged.pdf");

    let merge = pdf::PdfMergeTool::new(opts());
    let out = merge
        .call(pdf::PdfMergeArgs {
            input_paths: vec![sample_pdf(), sample_pdf()],
            output_path: merged.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["fileCount"], 2);
    assert!(v["pageCount"].as_u64().unwrap() >= 1);

    let split = pdf::PdfSplitTool::new(opts());
    let out = split
        .call(pdf::PdfSplitArgs {
            input_path: merged.to_string_lossy().into_owned(),
            output_dir: out_dir.join("parts").to_string_lossy().into_owned(),
            ranges: Some("1".into()),
        })
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["outputPaths"].as_array().unwrap().len(), 1);

    let meta_get = pdf::PdfMetadataGetTool::new(opts());
    let out = meta_get
        .call(pdf::PdfMetadataGetArgs {
            input_path: sample_pdf(),
        })
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["metadata"]["Title"].as_str().is_some());

    let meta_set = pdf::PdfMetadataSetTool::new(opts());
    let out_path = out_dir.join("meta.pdf");
    let out = meta_set
        .call(pdf::PdfMetadataSetArgs {
            input_path: sample_pdf(),
            output_path: out_path.to_string_lossy().into_owned(),
            metadata: [("title".into(), "rig title".into())].into(),
        })
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["metadata"]["Title"], "rig title");
}

#[tokio::test]
async fn extract_images() {
    let tool = pdf::PdfExtractImagesTool::new(opts());
    let out_dir = std::env::temp_dir().join(format!("rig_pdf_imgs_{}", std::process::id()));
    let out = tool
        .call(pdf::PdfExtractImagesArgs {
            input_path: repo_root()
                .join("pdf/creator/testdata/templates1.pdf")
                .to_string_lossy()
                .into_owned(),
            output_dir: out_dir.to_string_lossy().into_owned(),
            pages: None,
            format: Some("png".into()),
        })
        .await;
    println!("images: {out:?}");
    match out {
        Ok(text) => {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["format"], "png");
            assert!(v["images"].is_array());
        }
        // templates1.pdf may legitimately contain no raster images.
        Err(pdf::ToolError::PdfCli { .. }) => {}
        Err(e) => panic!("unexpected error: {e}"),
    }
}

#[tokio::test]
async fn registry_builds_toolset() {
    let set = pdf::all_tools();
    let defs = set.get_tool_definitions();
    assert_eq!(defs.len(), pdf::native_names().len());
    for name in pdf::native_names() {
        assert!(set.contains(name), "missing {name}");
    }
}
