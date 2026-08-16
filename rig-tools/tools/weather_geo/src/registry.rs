//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "geocode"
            | "get_ip_location"
            | "get_iss_position"
            | "get_sun_times"
            | "get_time_in_timezone"
            | "get_weather"
            | "get_weather_forecast"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "geocode",
        "get_ip_location",
        "get_iss_position",
        "get_sun_times",
        "get_time_in_timezone",
        "get_weather",
        "get_weather_forecast",
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
            "geocode" => {
                set.add_tool(GeocodeTool::default());
            }
            "get_ip_location" => {
                set.add_tool(GetIpLocationTool::default());
            }
            "get_iss_position" => {
                set.add_tool(GetIssPositionTool::default());
            }
            "get_sun_times" => {
                set.add_tool(GetSunTimesTool::default());
            }
            "get_time_in_timezone" => {
                set.add_tool(GetTimeInTimezoneTool::default());
            }
            "get_weather" => {
                set.add_tool(GetWeatherTool::default());
            }
            "get_weather_forecast" => {
                set.add_tool(GetWeatherForecastTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
