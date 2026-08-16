//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_competition_matches"
            | "get_competition_scorers"
            | "get_competition_standings"
            | "get_competitions"
            | "get_match_detail"
            | "get_person_info"
            | "get_team_info"
            | "get_team_matches"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_competition_matches",
        "get_competition_scorers",
        "get_competition_standings",
        "get_competitions",
        "get_match_detail",
        "get_person_info",
        "get_team_info",
        "get_team_matches",
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
            "get_competition_matches" => {
                set.add_tool(GetCompetitionMatchesTool::default());
            }
            "get_competition_scorers" => {
                set.add_tool(GetCompetitionScorersTool::default());
            }
            "get_competition_standings" => {
                set.add_tool(GetCompetitionStandingsTool::default());
            }
            "get_competitions" => {
                set.add_tool(GetCompetitionsTool::default());
            }
            "get_match_detail" => {
                set.add_tool(GetMatchDetailTool::default());
            }
            "get_person_info" => {
                set.add_tool(GetPersonInfoTool::default());
            }
            "get_team_info" => {
                set.add_tool(GetTeamInfoTool::default());
            }
            "get_team_matches" => {
                set.add_tool(GetTeamMatchesTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
