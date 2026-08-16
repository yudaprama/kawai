//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "calculate"
            | "define_word"
            | "get_all_fruits"
            | "get_country_info"
            | "get_fruit_info"
            | "get_github_repo"
            | "get_github_user"
            | "get_public_holidays"
            | "search_github_repos"
            | "search_papers"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "calculate",
        "define_word",
        "get_all_fruits",
        "get_country_info",
        "get_fruit_info",
        "get_github_repo",
        "get_github_user",
        "get_public_holidays",
        "search_github_repos",
        "search_papers",
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
            "calculate" => {
                set.add_tool(CalculateTool::default());
            }
            "define_word" => {
                set.add_tool(DefineWordTool::default());
            }
            "get_all_fruits" => {
                set.add_tool(GetAllFruitsTool::default());
            }
            "get_country_info" => {
                set.add_tool(GetCountryInfoTool::default());
            }
            "get_fruit_info" => {
                set.add_tool(GetFruitInfoTool::default());
            }
            "get_github_repo" => {
                set.add_tool(GetGithubRepoTool::default());
            }
            "get_github_user" => {
                set.add_tool(GetGithubUserTool::default());
            }
            "get_public_holidays" => {
                set.add_tool(GetPublicHolidaysTool::default());
            }
            "search_github_repos" => {
                set.add_tool(SearchGithubReposTool::default());
            }
            "search_papers" => {
                set.add_tool(SearchPapersTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
