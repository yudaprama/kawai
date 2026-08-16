//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "draw_cards"
            | "get_chuck_norris_joke"
            | "get_joke"
            | "get_star_wars_films"
            | "get_star_wars_planet"
            | "get_trivia_categories"
            | "get_trivia_questions"
            | "new_deck"
            | "search_star_wars_people"
            | "validate_email"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "draw_cards",
        "get_chuck_norris_joke",
        "get_joke",
        "get_star_wars_films",
        "get_star_wars_planet",
        "get_trivia_categories",
        "get_trivia_questions",
        "new_deck",
        "search_star_wars_people",
        "validate_email",
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
            "draw_cards" => {
                set.add_tool(DrawCardsTool::default());
            }
            "get_chuck_norris_joke" => {
                set.add_tool(GetChuckNorrisJokeTool::default());
            }
            "get_joke" => {
                set.add_tool(GetJokeTool::default());
            }
            "get_star_wars_films" => {
                set.add_tool(GetStarWarsFilmsTool::default());
            }
            "get_star_wars_planet" => {
                set.add_tool(GetStarWarsPlanetTool::default());
            }
            "get_trivia_categories" => {
                set.add_tool(GetTriviaCategoriesTool::default());
            }
            "get_trivia_questions" => {
                set.add_tool(GetTriviaQuestionsTool::default());
            }
            "new_deck" => {
                set.add_tool(NewDeckTool::default());
            }
            "search_star_wars_people" => {
                set.add_tool(SearchStarWarsPeopleTool::default());
            }
            "validate_email" => {
                set.add_tool(ValidateEmailTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
