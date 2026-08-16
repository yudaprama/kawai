//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "pdf_search_replace"
            | "pdf_search_text"
            | "pdf_extract_text"
            | "pdf_merge"
            | "pdf_split"
            | "pdf_page_info"
            | "pdf_metadata_get"
            | "pdf_metadata_set"
            | "pdf_extract_images"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "pdf_extract_images",
        "pdf_extract_text",
        "pdf_merge",
        "pdf_metadata_get",
        "pdf_metadata_set",
        "pdf_page_info",
        "pdf_search_replace",
        "pdf_search_text",
        "pdf_split",
    ]
}

/// Build a `ToolSet` containing every native tool.
pub fn all_tools() -> ToolSet {
    toolset_for(&native_names())
}

/// Build a `ToolSet` for the given subset of native tool names.
/// Panics on unknown names (validate with [`is_native`] first).
pub fn toolset_for(names: &[&str]) -> ToolSet {
    use crate::generated::*;
    let mut set = ToolSet::default();
    for name in names {
        match *name {
            "pdf_extract_images" => {
                set.add_tool(PdfExtractImagesTool::default());
            }
            "pdf_extract_text" => {
                set.add_tool(PdfExtractTextTool::default());
            }
            "pdf_merge" => {
                set.add_tool(PdfMergeTool::default());
            }
            "pdf_metadata_get" => {
                set.add_tool(PdfMetadataGetTool::default());
            }
            "pdf_metadata_set" => {
                set.add_tool(PdfMetadataSetTool::default());
            }
            "pdf_page_info" => {
                set.add_tool(PdfPageInfoTool::default());
            }
            "pdf_search_replace" => {
                set.add_tool(PdfSearchReplaceTool::default());
            }
            "pdf_search_text" => {
                set.add_tool(PdfSearchTextTool::default());
            }
            "pdf_split" => {
                set.add_tool(PdfSplitTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
