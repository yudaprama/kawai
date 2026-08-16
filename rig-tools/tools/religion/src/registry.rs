//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_bible_verse"
            | "get_on_this_day"
            | "get_quran_ayah"
            | "get_quran_juz"
            | "get_quran_surah"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_bible_verse",
        "get_on_this_day",
        "get_quran_ayah",
        "get_quran_juz",
        "get_quran_surah",
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
            "get_bible_verse" => {
                set.add_tool(GetBibleVerseTool::default());
            }
            "get_on_this_day" => {
                set.add_tool(GetOnThisDayTool::default());
            }
            "get_quran_ayah" => {
                set.add_tool(GetQuranAyahTool::default());
            }
            "get_quran_juz" => {
                set.add_tool(GetQuranJuzTool::default());
            }
            "get_quran_surah" => {
                set.add_tool(GetQuranSurahTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
