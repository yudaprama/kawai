//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_earthquakes_by_region"
            | "get_flights_in_area"
            | "get_recent_earthquakes"
            | "get_recent_flights"
            | "get_significant_earthquakes"
            | "get_spacex_latest_launch"
            | "get_spacex_rockets"
            | "get_spacex_upcoming_launches"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_earthquakes_by_region",
        "get_flights_in_area",
        "get_recent_earthquakes",
        "get_recent_flights",
        "get_significant_earthquakes",
        "get_spacex_latest_launch",
        "get_spacex_rockets",
        "get_spacex_upcoming_launches",
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
            "get_earthquakes_by_region" => {
                set.add_tool(GetEarthquakesByRegionTool::default());
            }
            "get_flights_in_area" => {
                set.add_tool(GetFlightsInAreaTool::default());
            }
            "get_recent_earthquakes" => {
                set.add_tool(GetRecentEarthquakesTool::default());
            }
            "get_recent_flights" => {
                set.add_tool(GetRecentFlightsTool::default());
            }
            "get_significant_earthquakes" => {
                set.add_tool(GetSignificantEarthquakesTool::default());
            }
            "get_spacex_latest_launch" => {
                set.add_tool(GetSpacexLatestLaunchTool::default());
            }
            "get_spacex_rockets" => {
                set.add_tool(GetSpacexRocketsTool::default());
            }
            "get_spacex_upcoming_launches" => {
                set.add_tool(GetSpacexUpcomingLaunchesTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
