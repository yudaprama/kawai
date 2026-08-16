//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_news_sources" | "get_top_headlines" | "get_top_news" | "search_news"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_news_sources",
        "get_top_headlines",
        "get_top_news",
        "search_news",
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
            "get_news_sources" => {
                set.add_tool(GetNewsSourcesTool::default());
            }
            "get_top_headlines" => {
                set.add_tool(GetTopHeadlinesTool::default());
            }
            "get_top_news" => {
                set.add_tool(GetTopNewsTool::default());
            }
            "search_news" => {
                set.add_tool(SearchNewsTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
