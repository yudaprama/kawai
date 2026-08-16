//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "browser_content_extract"
            | "browser_json_extract"
            | "browser_links_extract"
            | "browser_markdown_extract"
            | "browser_scrape_elements"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "browser_content_extract",
        "browser_json_extract",
        "browser_links_extract",
        "browser_markdown_extract",
        "browser_scrape_elements",
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
            "browser_content_extract" => {
                set.add_tool(BrowserContentExtractTool::default());
            }
            "browser_json_extract" => {
                set.add_tool(BrowserJsonExtractTool::default());
            }
            "browser_links_extract" => {
                set.add_tool(BrowserLinksExtractTool::default());
            }
            "browser_markdown_extract" => {
                set.add_tool(BrowserMarkdownExtractTool::default());
            }
            "browser_scrape_elements" => {
                set.add_tool(BrowserScrapeElementsTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
