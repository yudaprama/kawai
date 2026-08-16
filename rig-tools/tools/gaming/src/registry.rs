//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_pokemon" | "get_pokemon_species" | "get_pokemon_type"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec!["get_pokemon", "get_pokemon_species", "get_pokemon_type"]
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
            "get_pokemon" => {
                set.add_tool(GetPokemonTool::default());
            }
            "get_pokemon_species" => {
                set.add_tool(GetPokemonSpeciesTool::default());
            }
            "get_pokemon_type" => {
                set.add_tool(GetPokemonTypeTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
